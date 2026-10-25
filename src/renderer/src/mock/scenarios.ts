import type { NoticeEvent, SessionEvent } from '../../../shared/ipc/core'
import type { FakeOptions } from './fake-core'
import * as fx from './fixtures'

// Named starting states for the browser mock (?mock=<name>) and for tests.

const now = (): number => performance.now()

function session(patch: Partial<SessionEvent>): SessionEvent {
  return { phase: 'idle', role: null, roomId: null, fileName: null, fileSize: null, durationS: null, ...patch }
}

const joinInfo = (freeBytes: number): NonNullable<SessionEvent['joinInfo']> => ({
  name: fx.FILE.name,
  size: fx.FILE.size,
  dir: fx.JOIN_DIR,
  freeBytes,
})

function preparing(file = fx.FILE, media?: SessionEvent['media']): fx.StateSlices {
  return {
    session: session({
      phase: 'preparing',
      role: 'host',
      roomId: fx.ROOM_ID,
      fileName: file.name,
      fileSize: file.size,
      ...(media ? { media } : {}),
    }),
    prepare: {
      stage: 'hashing' as const,
      bytesDone: file.size * 0.43,
      bytesTotal: file.size,
      bytesPerSec: 1_450_000_000,
      cached: false,
      feasibility: { needBps: 2_900_000, uploadBps: 2_100_000 },
    },
    player: fx.player('ready'),
  }
}

export const SCENARIOS = {
  home: () => ({ session: session({}), player: fx.player('ready') }),
  preparing: () => preparing(),
  connecting: () => ({ session: session({ phase: 'connecting', role: 'viewer' }), player: fx.player('ready') }),
  pending: () => ({ session: session({ phase: 'pending-admission', role: 'viewer' }), player: fx.player('ready') }),
  // the host is still preparing: core forwards session.preparing as prepare events (bytes = pct × 1000)
  'connecting-host-preparing': () => ({
    session: session({ phase: 'connecting', role: 'viewer' }),
    prepare: { stage: 'hashing' as const, bytesDone: 43_000, bytesTotal: 100_000, bytesPerSec: 0, cached: false },
    player: fx.player('ready'),
  }),
  'confirm-join': () => ({
    session: session({
      phase: 'confirm-join',
      role: 'viewer',
      roomId: fx.ROOM_ID,
      fileName: fx.FILE.name,
      fileSize: fx.FILE.size,
      durationS: fx.FILE.durationS,
      joinInfo: joinInfo(120_000_000_000),
    }),
    player: fx.player('ready'),
  }),
  'confirm-join-low-space': () => ({
    session: session({
      phase: 'confirm-join',
      role: 'viewer',
      roomId: fx.ROOM_ID,
      fileName: fx.FILE.name,
      fileSize: fx.FILE.size,
      durationS: fx.FILE.durationS,
      joinInfo: joinInfo(20_000_000_000),
    }),
    player: fx.player('ready'),
  }),
  'room-host': () => fx.inRoom('host', now()),
  // a joiner that cannot reach the host: a member passed its request on (RoomEvent.pending[].via)
  'room-host-pending-via': () => {
    const s = fx.inRoom('host', now())
    if (!s.room) return s
    return { ...s, room: { ...s.room, pending: [...s.room.pending, { id: 'p-kai', name: 'Kai', via: 'Sam' }] } }
  },
  'room-viewer': () => fx.inRoom('viewer', now()),
  // a series: the playlist panel, with episode 2 playing
  'room-host-playlist': () => ({ ...fx.inRoom('host', now()), playlist: fx.playlist('host') }),
  'room-viewer-playlist': () => ({ ...fx.inRoom('viewer', now()), playlist: fx.playlist('viewer') }),
  // episode 2 ended: the countdown to episode 3 (the host can play it now or cancel)
  'ended-host-playlist': () => ({
    ...fx.inRoom('host', now()),
    sync: fx.sync('host', { mode: 'ended' }),
    playlist: fx.playlist('host', { advance: true }),
  }),
  'ended-viewer-playlist': () => ({
    ...fx.inRoom('viewer', now()),
    sync: fx.sync('viewer', { mode: 'ended' }),
    playlist: fx.playlist('viewer', { advance: true }),
  }),
  'room-viewer-waiting': () => {
    const s = fx.inRoom('viewer', now())
    return {
      ...s,
      sync: fx.sync('viewer', {
        mode: 'waiting',
        wait: { reason: 'buffering' as const, waitingFor: ['Ola'], softDeadline: null },
      }),
    }
  },
  // this viewer fell behind the host while the room plays: the desync banner with Resync to live
  'room-viewer-behind': () => {
    const s = fx.inRoom('viewer', now())
    return { ...s, sync: fx.sync('viewer', { mode: 'playing', desync: { state: 'behind' as const, behindS: 3.5 } }) }
  },
  // the video reached its end; the room stays open (sync mode 'ended', phase still 'in-room')
  'ended-host': () => {
    const s = fx.inRoom('host', now())
    return { ...s, sync: fx.sync('host', { mode: 'ended' }) }
  },
  'ended-viewer': () => {
    const s = fx.inRoom('viewer', now())
    return { ...s, sync: fx.sync('viewer', { mode: 'ended' }) }
  },
  // the host closed the room (phase 'ended')
  'room-closed': () => {
    const s = fx.inRoom('viewer', now())
    return { ...s, session: { ...s.session, phase: 'ended' as const }, sync: fx.sync('viewer', { mode: 'paused' }) }
  },
  // ...and this viewer has the whole video: Save file shows the saving banner, then where the file went
  'room-closed-complete': () => {
    const s = fx.inRoom('viewer', now())
    const transfer = { downBps: 0, upBps: 0, progress: 1, missingAheadBytes: 0, etaToEofS: null, diskLow: false }
    return {
      ...s,
      session: { ...s.session, phase: 'ended' as const },
      sync: fx.sync('viewer', { mode: 'paused' }),
      transfer,
    }
  },
  // session.leave / transfer.saveFile running, as core reports it (e.g. after a reload during a long save)
  leaving: () => leaving(),
  // ...a 'save' export, which core's event says (SessionEvent.leave): the banner says so after a reload too
  'leaving-save': () => leaving('save'),
  // an fMP4 without sidx: viewers can only play it once complete; the host is told how to remux it
  'preparing-full-download': () => preparing(fx.FMP4_FILE, fx.media(true)),
  'room-host-full-download': () => fullDownload(fx.inRoom('host', now())),
  'room-viewer-full-download': () => fullDownload(fx.inRoom('viewer', now())),
  // no seek index (an MKV without Cues): seeking is slower for viewers; poor interleave: more data per start or seek
  'preparing-linear': () => preparing(fx.FILE, fx.LINEAR_MKV),
  'room-host-linear': () => withMedia(fx.inRoom('host', now()), fx.LINEAR_MKV),
  'room-viewer-linear': () => withMedia(fx.inRoom('viewer', now()), fx.LINEAR_MKV),
  'room-host-poor-interleave': () => withMedia(fx.inRoom('host', now()), fx.POOR_MP4),
  // Home after a restart that finishes a 'save' export a quit interrupted (SCENARIO_NOTICES)
  'export-finished': () => ({ session: session({}), player: fx.player('ready') }),
  // Home with a cut-off save in Recent rooms (SCENARIO_CORE): Finish saving gives 'finished', Cancel saving 'rejoin'
  'recent-export': () => ({ session: session({}), player: fx.player('ready') }),
  // ...whose folder (an external drive) is not connected: Finish saving gives 'waiting'; core's startup notice too
  'recent-export-waiting': () => ({ session: session({}), player: fx.player('ready') }),
  // ...whose data is gone: Finish saving gives 'rejoin', and the room offers Resume
  'recent-export-lost': () => ({ session: session({}), player: fx.player('ready') }),
  'mpv-missing': () => ({ session: session({}), player: fx.player('missing') }),
  'mpv-too-old': () => ({ session: session({}), player: fx.player('tooOld') }),
  error: () => ({
    session: session({
      phase: 'error',
      error: { code: 'WTP_AUTH_FAILED', message: 'The invite was rejected by the host.' },
    }),
    player: fx.player('ready'),
  }),
} satisfies Record<string, () => fx.StateSlices>

function fullDownload(s: ReturnType<typeof fx.inRoom>): ReturnType<typeof fx.inRoom> {
  const file = { fileName: fx.FMP4_FILE.name, fileSize: fx.FMP4_FILE.size, durationS: fx.FMP4_FILE.durationS }
  return { ...s, session: { ...s.session, ...file, media: fx.media(true) } }
}

function withMedia(
  s: ReturnType<typeof fx.inRoom>,
  media: NonNullable<SessionEvent['media']>,
): ReturnType<typeof fx.inRoom> {
  return { ...s, session: { ...s.session, media } }
}

/** A viewer's room while core reports 'leaving'; `leave` as core's event says it (absent from an older core). */
function leaving(leave?: SessionEvent['leave']): fx.StateSlices {
  const s = fx.inRoom('viewer', now())
  const { role, roomId, fileName, fileSize, durationS, media } = s.session
  const event: SessionEvent = { phase: 'leaving', role, roomId, fileName, fileSize, durationS }
  const session = { ...event, ...(media ? { media } : {}), ...(leave ? { leave } : {}) }
  // a viewer saves only the whole video
  if (leave !== 'save' || !s.transfer) return { ...s, session }
  return { ...s, session, transfer: { ...s.transfer, progress: 1, etaToEofS: null } }
}

export type ScenarioName = keyof typeof SCENARIOS

/** Notices a scenario's core sends right after connecting; the browser mock emits them. */
export const SCENARIO_NOTICES: Partial<Record<ScenarioName, () => NoticeEvent[]>> = {
  'export-finished': () => {
    const n = fx.exportNotices()
    return [n.resumed, n.finished]
  },
  'recent-export-waiting': () => [fx.waitingNotice()],
}

/** What a scenario's core holds besides its state (the browser mock and the test harness use it). */
export const SCENARIO_CORE: Partial<Record<ScenarioName, () => Pick<FakeOptions, 'recent' | 'exportLost'>>> = {
  'recent-export': () => ({ recent: [fx.cutOffSave(), ...fx.recentRooms()] }),
  'recent-export-waiting': () => ({ recent: [fx.cutOffSave(true), ...fx.recentRooms()] }),
  'recent-export-lost': () => ({ recent: [fx.cutOffSave(), ...fx.recentRooms()], exportLost: [fx.SAVE_ROOM_ID] }),
}

export function isScenario(name: string): name is ScenarioName {
  return Object.hasOwn(SCENARIOS, name)
}
