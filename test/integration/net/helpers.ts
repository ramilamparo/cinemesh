import { type ChildProcess, spawn } from 'node:child_process'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { type NetLog, Room, type RoomOptions, type RoomTiming } from '../../../src/core/net/room.js'

// A local HyperDHT testnet plus rooms on it, all torn down by cleanup().

export const FAST: Partial<RoomTiming> = {
  admitWaitMs: 1000,
  rejoinMs: 3000,
  hostAwayMs: 3000,
  hostRefreshMs: 3000,
  heartbeatMs: 1000,
  ctrlRetryMs: 500,
  ctrlPairWaitMs: 3000,
  meshRepairMs: 1000,
  kickGraceMs: 300,
  tickMs: 200,
}

const quiet: NetLog = { debug: () => undefined, info: () => undefined, warn: () => undefined }
const stamp = (m: string): string => `${new Date().toISOString().slice(11, 23)} ${m}`
const loud: NetLog = {
  debug: () => undefined,
  info: (m) => console.log(stamp(m)),
  warn: (m) => console.warn(stamp(m)),
}

export class Harness {
  readonly rooms: Room[] = []
  private constructor(
    readonly testnet: Testnet,
    readonly bootstrap: string,
  ) {}

  static async start(): Promise<Harness> {
    const testnet = await createTestnet(3)
    const bootstrap = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    return new Harness(testnet, bootstrap)
  }

  options(name: string, extra: Partial<RoomOptions> = {}): RoomOptions {
    return {
      displayName: name,
      settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
      store: null,
      env: { WT_BOOTSTRAP: this.bootstrap },
      log: process.env.WT_TEST_LOG ? loud : quiet,
      ...extra,
      testing: { ...extra.testing, timing: { ...FAST, ...extra.testing?.timing } },
    }
  }

  async host(name = 'Host', extra: Partial<RoomOptions> & { roomName?: string } = {}): Promise<Room> {
    const room = await Room.create({ ...this.options(name, extra), name: extra.roomName ?? 'Test room' })
    this.rooms.push(room)
    await room.ready()
    return room
  }

  async viewer(invite: string, name: string, extra: Partial<RoomOptions> = {}): Promise<Room> {
    const room = await Room.join(invite, this.options(name, extra))
    this.rooms.push(room)
    await room.ready()
    return room
  }

  track(room: Room): Room {
    this.rooms.push(room)
    return room
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.rooms.map((r) => r.close()))
    await this.testnet.destroy()
  }
}

export async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<number> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${String(timeoutMs)} ms: ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  return Date.now() - started
}

export function memberIds(room: Room): string[] {
  return room
    .members()
    .map((m) => m.id)
    .sort()
}

// A parent that forks the child the way the tests do, then prints the child's pid once it reports ready.
const STAND_IN = `
import { fork } from 'node:child_process'
const [script, ready, ...args] = JSON.parse(process.env.WT_STAND_IN)
const child = fork(script, args, { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
child.on('message', (m) => { if (m.t === ready) process.stdout.write(String(child.pid) + '\\n') })
child.on('exit', () => process.exit(1))
setInterval(() => {}, 1 << 30)
`

/**
 * Forks `script` (under tsx, with `env`) from a stand-in parent process, and resolves once the child has sent
 * {t: ready}. Killing `parent` then leaves the child behind, as a test process that dies without its afterEach
 * would (a vitest worker killed on a timeout, a crash).
 */
export async function orphanable(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  ready: string,
): Promise<{ parent: ChildProcess; childPid: number }> {
  const parent = spawn(process.execPath, ['--input-type=module', '-e', STAND_IN], {
    env: { ...env, WT_STAND_IN: JSON.stringify([script, ready, ...args]) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const childPid = await new Promise<number>((resolve, reject) => {
    let out = ''
    parent.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const line = out.split('\n')[0]
      if (out.includes('\n') && line) resolve(Number(line))
    })
    parent.once('exit', (code) =>
      reject(new Error(`stand-in parent exited (${String(code)}) before its child was ready`)),
    )
  })
  return { parent, childPid }
}

/** Whether a process with this pid is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
