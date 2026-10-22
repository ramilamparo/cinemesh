// Must stay the first import (see env-first.ts).
import './env-first.js'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { MainToCore } from '../shared/ipc/control.js'
import { CORE_PROTOCOL, type Versions } from '../shared/ipc/core.js'
import { type RpcPort, createHostTransport } from './host-transport.js'
import { log } from './log.js'
import { RoomStore } from './net/identity.js'
import { RpcServer } from './rpc-server.js'
import { runSelftest } from './selftest.js'
import type { SessionManager } from './session/manager.js'

// Entry of the 'wt-core' utilityProcess (and of headless runs with --stdio-transport).

const transport = createHostTransport()
const loopDelay = monitorEventLoopDelay({ resolution: 10 })
loopDelay.enable()
const startedAt = performance.now()

let initStarted = false
/** set once every handler is registered: ports that come earlier wait in earlyPorts */
let rpc: RpcServer | null = null
let sessions: SessionManager | null = null
const earlyPorts: RpcPort[] = []
const early: MainToCore[] = []

transport.onControl((msg: MainToCore, ports) => {
  switch (msg.type) {
    case 'init':
      void init(msg).catch((e: unknown) => {
        log.error('core init failed', e)
        transport.sendControl({ type: 'fatal', message: e instanceof Error ? e.message : String(e) })
      })
      break
    case 'renderer-port':
      for (const port of ports) {
        if (rpc) rpc.attach(port)
        else earlyPorts.push(port)
      }
      break
    case 'settings':
    case 'theme':
    case 'mpv':
      if (sessions) apply(sessions, msg)
      else early.push(msg)
      break
    case 'shutdown':
      void shutdown()
      break
  }
})

function apply(s: SessionManager, msg: MainToCore): void {
  if (msg.type === 'settings') s.updateSettings(msg.settings)
  else if (msg.type === 'theme') s.updateTheme(msg.theme)
  else if (msg.type === 'mpv') s.updateMpv(msg.mpv)
}

async function init(msg: Extract<MainToCore, { type: 'init' }>): Promise<void> {
  if (initStarted) return
  initStarted = true
  const versions: Versions = {
    app: msg.appVersion,
    // Electron's typings declare these as always present; under plain Node they are not.
    electron: (process.versions as Partial<Record<string, string>>).electron ?? null,
    node: process.versions.node,
    chrome: (process.versions as Partial<Record<string, string>>).chrome ?? null,
    protocol: CORE_PROTOCOL,
  }
  const server = new RpcServer(versions)
  try {
    await log.open(msg.paths.logsDir)
    log.info(`core ${msg.appVersion} up (node ${process.versions.node}, transport ${transport.kind})`)

    if (msg.selftest) {
      const report = await runSelftest(msg.paths.userData, msg.mpv)
      for (const c of report.checks) log.info(`selftest ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
      transport.sendControl({ type: 'selftest', report })
      return
    }

    // WebTorrent (and ws under it) loads here, after env-first.ts: a bundle hoists static package imports
    // above every line of its own code, env-first's included
    const { SessionManager } = await import('./session/manager.js')
    let keepAwake = false
    const manager = new SessionManager(server, {
      paths: msg.paths,
      settings: msg.settings,
      theme: msg.theme,
      mpv: msg.mpv,
      appVersion: msg.appVersion,
      store: new RoomStore(msg.paths.userData),
      fakePlayer: process.env.WT_FAKE_PLAYER === '1',
      resumeActive: msg.resumeActive === true,
      log,
      control: {
        power(on) {
          if (on === keepAwake) return
          keepAwake = on
          transport.sendControl({ type: 'power', keepAwake: on })
        },
        mpvPid: (pid) => transport.sendControl({ type: 'mpv-pid', pid }),
        showApp: () => transport.sendControl({ type: 'show-app' }),
      },
    })
    sessions = manager
    for (const m of early.splice(0)) apply(manager, m)
    setupHandlers(server, versions, manager)
  } finally {
    // Only now: the preload sends hello and every request it queued as soon as it has a port, and each must
    // find its handler (a cold start from an invite link would drop the join). A failed init still answers.
    rpc = server
    for (const port of earlyPorts.splice(0)) server.attach(port)
  }
  transport.sendControl({ type: 'ready', versions })
}

function setupHandlers(server: RpcServer, versions: Versions, manager: SessionManager): void {
  server.handle('app.ping', () => ({ pong: true as const, versions }))
  server.handle('diagnostics.get', () => {
    const mpv = manager.mpvDiagnostics
    return {
      versions,
      uptimeS: Math.round((performance.now() - startedAt) / 1000),
      eventLoopDelayP99Ms: loopDelay.count > 0 ? loopDelay.percentile(99) / 1e6 : null,
      rssBytes: process.memoryUsage.rss(),
      ...manager.diagnostics(),
      mpv: { path: mpv.path, version: mpv.version, vo: null, hwdec: null },
      logTail: log.tail(),
    }
  })
}

async function shutdown(): Promise<void> {
  log.info('core shutting down')
  await sessions?.shutdown().catch((e: unknown) => log.error('leaving on shutdown failed', e))
  await log.flush()
  process.exit(0)
}

process.on('uncaughtException', (e) => {
  log.error('uncaught exception', e)
  transport.sendControl({ type: 'fatal', message: e.message })
})
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e))
