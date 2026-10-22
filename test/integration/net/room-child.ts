// A Room in its own process, so a test can SIGKILL it: a real crash (no bye, sockets left open until the
// kernel drops them), which room.close() in the test's own process cannot fake. Run with tsx:
//   room-child.ts host <dir>              a new room (host)
//   room-child.ts join <dir> <invite>     a viewer
//   room-child.ts resume <dir> <roomId>   either role, from the room.json a killed child left in <dir>
// Bootstrap comes from WT_BOOTSTRAP. Messages to the parent are ChildMessage; it may send ChildCommand.
// When the parent goes away without killing it (a vitest worker killed on a timeout, a crash), the IPC channel
// closes: the child closes its room and exits, instead of living on with its swarm.
import { RoomStore } from '../../../src/core/net/identity.js'
import { Room, type RoomOptions } from '../../../src/core/net/room.js'

export type ChildMessage =
  | { t: 'up'; invite: string; roomId: string; self: string; hostKey: string }
  | { t: 'peer'; id: string }
  | { t: 'auth-failed'; peerId: string; code: string }
  | { t: 'banned'; id: number; keys: string[] }

export type ChildCommand = { t: 'banned'; id: number; keys: string[] }

const [mode = '', dir = '', arg = ''] = process.argv.slice(2)
const send = (m: ChildMessage): void => {
  if (process.connected) process.send?.(m)
}
/** how long closing the room may take once the parent is gone */
const ORPHAN_CLOSE_MS = 2000
let room: Room | null = null
process.once('disconnect', () => {
  const bounded = new Promise((resolve) => setTimeout(resolve, ORPHAN_CLOSE_MS))
  void Promise.race([room?.close(), bounded]).finally(() => process.exit(0))
})
const store = new RoomStore(dir)
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined }
const stamp = (m: string): string => `${new Date().toISOString().slice(11, 23)} [child ${mode}] ${m}`
const opts: RoomOptions = {
  displayName: 'Host',
  settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
  store,
  log: process.env.WT_TEST_LOG
    ? { ...quiet, info: (m) => console.log(stamp(m)), warn: (m) => console.warn(stamp(m)) }
    : quiet,
}

async function open(): Promise<Room> {
  if (mode === 'host') return Room.create({ ...opts, name: 'Crash test' })
  if (mode === 'join') return Room.join(arg, { ...opts, displayName: 'Sam' })
  const record = await store.load(arg)
  if (!record) throw new Error(`no room ${arg} in ${dir}`)
  // the same member under the same name, as a restarted app is
  return Room.resume(record, { ...opts, displayName: record.role === 'host' ? 'Host' : 'Sam' })
}

const opened = (room = await open())
opened.on('peer', (p) => send({ t: 'peer', id: p.id }))
opened.on('auth-failed', (f) => send({ t: 'auth-failed', ...f }))
const bans = (opened as unknown as { bans: { has(key: string): boolean } }).bans
process.on('message', (m: ChildCommand) => {
  send({ t: 'banned', id: m.id, keys: m.keys.filter((k) => bans.has(k)) })
})
await opened.ready()
send({ t: 'up', invite: opened.invite().code, roomId: opened.id, self: opened.self, hostKey: opened.hostKey })
setInterval(() => undefined, 1 << 30)
