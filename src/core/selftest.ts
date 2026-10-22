import { statfs } from 'node:fs/promises'
import type { MpvInfo, SelftestReport } from '../shared/ipc/control.js'
import { WEBTORRENT_OPTIONS } from './transfer/client-options.js'

type Check = SelftestReport['checks'][number]

// Native addons we must never load: WebTorrent's WebRTC (node-datachannel) and uTP paths are stubbed out.
const FORBIDDEN_ADDONS = /node[_-]datachannel|utp[_-]native|utp\.node/i
// ws's optional addons: they ship (an optional dependency), but WS_NO_BUFFER_UTIL / WS_NO_UTF_8_VALIDATE keep
// them unloaded (main's fork env, src/core/env-first.ts; ADR 0001 finding 3)
const WS_ADDONS = /[\\/](bufferutil|utf-8-validate)[\\/]/

/**
 * Spike S1 / packaged smoke test: proves the stack loads inside the packaged utilityProcess
 * (ESM, asar unpacking, N-API prebuilds) and that WebTorrent opens no TCP listener.
 * Touches no network: the DHT is created with an empty bootstrap list. The report also carries main's mpv
 * lookup (`mpv`, from init.mpv) for check-package to judge.
 */
export async function runSelftest(userData: string, mpv: MpvInfo): Promise<SelftestReport> {
  const checks: Check[] = []
  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await fn() })
    } catch (e) {
      checks.push({ name, ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e) })
    }
  }

  await check('sodium-native', async () => {
    const sodium = (await import('sodium-native')).default
    const out = Buffer.alloc(32)
    sodium.crypto_generichash(out, Buffer.from('cinemesh'))
    return out.toString('hex').slice(0, 16)
  })

  await check('webtorrent: no TCP listener', async () => {
    const { default: WebTorrent } = await import('webtorrent')
    const client = new WebTorrent(WEBTORRENT_OPTIONS)
    try {
      await new Promise<void>((resolve, reject) => {
        if (client.listening) resolve()
        client.once('listening', () => resolve())
        client.once('error', reject)
      })
      if (client._connPool !== null && client._connPool !== undefined) {
        throw new Error('ConnPool was created: patches/webtorrent+3.0.21.patch is not applied')
      }
      // seeding exercises metadata, the chunk store and torrent-discovery with every source off
      const torrent = await new Promise<{ infoHash: string }>((resolve, reject) => {
        client.once('error', reject)
        client.seed(Buffer.from('cinemesh selftest'), { name: 'selftest.bin', private: true }, resolve)
      })
      return `listening without ConnPool; seeded ${torrent.infoHash.slice(0, 8)}`
    } finally {
      await new Promise<void>((resolve) => client.destroy(() => resolve()))
    }
  })

  await check('hyperswarm + udx-native', async () => {
    const { default: Hyperswarm } = await import('hyperswarm')
    const swarm = new Hyperswarm({ bootstrap: [] })
    await swarm.dht.ready()
    await swarm.destroy()
    return 'DHT socket opened and closed'
  })

  await check('fs.statfs', async () => {
    const s = await statfs(userData)
    return `${String(Math.round((s.bavail * s.bsize) / 2 ** 30))} GiB free`
  })

  await check('loaded native addons', () => {
    const report = process.report.getReport() as unknown as { sharedObjects?: string[] }
    const addons = (report.sharedObjects ?? []).filter((f) => f.endsWith('.node'))
    const bad = addons.filter((f) => FORBIDDEN_ADDONS.test(f) || WS_ADDONS.test(f))
    if (bad.length > 0) return Promise.reject(new Error(`unexpected addons loaded: ${bad.join(', ')}`))
    return Promise.resolve(addons.map(shortPath).join(', ') || 'none')
  })

  return {
    ok: checks.every((c) => c.ok),
    checks,
    mpv: {
      kind: mpv.kind,
      path: mpv.path,
      version: mpv.version,
      // MpvInfo: no status means 'ok' when a path is set, else 'missing'
      status: mpv.status ?? (mpv.path ? 'ok' : 'missing'),
      ...(mpv.tried ? { tried: mpv.tried } : {}),
    },
  }
}

function shortPath(p: string): string {
  const i = p.lastIndexOf('node_modules')
  return i >= 0 ? p.slice(i + 'node_modules/'.length) : p
}
