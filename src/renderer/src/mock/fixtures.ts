import type {
  CoreEvents,
  CoreSnapshot,
  NoticeEvent,
  PeerView,
  PlayerEvent,
  PlaylistEvent,
  RecentRoom,
  Role,
  SessionEvent,
  SyncEvent,
  TracksEvent,
} from '../../../shared/ipc/core'
import type { PeerWarning } from '../../../shared/peer-warnings'
import { encodeCoverage } from '../lib/coverage'

// Realistic payloads for the fake core. Times are performance.now() based, like core's monotonic clock.

export const FILE = { name: 'Big.Buck.Bunny.2160p.HDR.mkv', size: 58_200_000_000, durationS: 5_400 }
export const INVITE = 'cinemesh://join/' + 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(4).slice(0, 112)
export const ROOM_ID = 'r-7f3k2'

export type StateSlices = Omit<CoreSnapshot, 'versions'>

export const versions: CoreSnapshot['versions'] = {
  app: '0.1.0-mock',
  electron: null,
  node: 'mock',
  chrome: null,
  protocol: 1,
}

/**
 * SessionEvent.media for FILE (an MKV with Cues), or for an fMP4 without sidx that plays only once complete. The
 * interleave is what core's indexers report: judged for MKV, 'unknown' for fMP4.
 */
export function media(fullDownload = false): NonNullable<SessionEvent['media']> {
  return fullDownload
    ? { container: 'fmp4', seekMode: 'linear', fullDownload: true, interleave: 'unknown' }
    : { container: 'mkv', seekMode: 'index', fullDownload: false, interleave: 'good' }
}

/** SessionEvent.media for files that stream, but slowly: an MKV without Cues, or a poorly interleaved MP4. */
export const LINEAR_MKV: NonNullable<SessionEvent['media']> = {
  container: 'mkv',
  seekMode: 'linear',
  fullDownload: false,
  interleave: 'good',
}
export const POOR_MP4: NonNullable<SessionEvent['media']> = {
  container: 'mp4',
  seekMode: 'index',
  fullDownload: false,
  interleave: 'poor',
}

/** A fragmented MP4 without sidx (fullDownload); same length as FILE, so the other slices still fit. */
export const FMP4_FILE = { name: 'Concert.Recording.2024.mp4', size: 6_800_000_000, durationS: FILE.durationS }

/** The folder chosen when joining (JoinConfirm's default); a save without `dest` goes there. */
export const JOIN_DIR = '/home/alex/Downloads/Cinemesh'

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Core's word for every finished save (transfer.saveFile, session.leave 'save', startup, transfer.finishExport). */
export function savedNotice(path = `${JOIN_DIR}/${FILE.name}`): NoticeEvent {
  return { level: 'info', code: 'transfer.export-finished', message: `Saved ${baseName(path)}`, path }
}

/** Core's notices about a 'save' export that a quit interrupted, which it finishes at the next startup. */
export function exportNotices(path = `${JOIN_DIR}/${FILE.name}`): {
  resumed: NoticeEvent
  finished: NoticeEvent
  failed: NoticeEvent
} {
  const name = baseName(path)
  return {
    resumed: { level: 'info', code: 'transfer.export-resumed', message: `Finishing saving ${name}…` },
    finished: savedNotice(path),
    failed: {
      level: 'warn',
      code: 'transfer.export-failed',
      message: `Could not finish saving ${name}: parts of the download are gone. Resume the room from Recent rooms to download the missing parts again, then save it.`,
    },
  }
}

/** The room of cutOffSave(). */
export const SAVE_ROOM_ID = 'r-save1'

/**
 * A viewer's room whose 'save' a quit, a crash or a missing drive cut off (RecentRoom.export); `waiting`: the folder it
 * saves into is not there now (an external drive, here).
 */
export function cutOffSave(waiting = false, running = false): RecentRoom {
  return {
    roomId: SAVE_ROOM_ID,
    name: "Maya's room",
    role: 'viewer',
    fileName: FILE.name,
    fileSize: FILE.size,
    lastActiveAt: Date.now() - 40 * 60_000,
    progress: 1,
    resumable: true,
    export: {
      name: FILE.name,
      dest: waiting ? '/media/alex/External' : JOIN_DIR,
      waiting,
      ...(running ? { running } : {}),
    },
  }
}

/** Core's notice at startup for a cut-off save whose folder is not there, with Finish saving for once it is. */
export function waitingNotice(room: RecentRoom = cutOffSave(true)): NoticeEvent {
  const name = room.export?.name ?? room.fileName
  return {
    level: 'warn',
    code: 'transfer.export-waiting',
    message: `Saving ${name} is waiting for ${room.export?.dest ?? 'its folder'}: connect it, then choose Finish saving.`,
    action: { label: 'Finish saving', request: 'transfer.finishExport', params: { roomId: room.roomId } },
  }
}

export function player(status: PlayerEvent['status'] = 'ready'): PlayerEvent {
  return {
    status,
    version: status === 'missing' ? null : status === 'tooOld' ? '0.35.1' : '0.41.0',
    hdr: { source: 'hdr', output: 'tonemapped', maxCll: 1000, gpuContext: 'waylandvk', hwdec: 'vaapi' },
  }
}

export function tracks(): TracksEvent {
  return {
    audio: [
      { id: 1, title: 'Surround 5.1', lang: 'eng', codec: 'eac3', default: true, forced: false, external: false },
      { id: 2, title: 'Commentary', lang: 'eng', codec: 'aac', default: false, forced: false, external: false },
      { id: 3, title: null, lang: 'jpn', codec: 'opus', default: false, forced: false, external: false },
    ],
    sub: [
      { id: 1, title: 'English', lang: 'eng', codec: 'ass', default: true, forced: false, external: false },
      { id: 2, title: 'Signs', lang: 'eng', codec: 'ass', default: false, forced: true, external: false },
      { id: 3, title: 'friends.srt', lang: null, codec: 'subrip', default: false, forced: false, external: true },
    ],
    aid: 1,
    sid: 1,
    volume: 80,
    muted: false,
  }
}

export function sync(role: Role, patch: Partial<SyncEvent> = {}): SyncEvent {
  const perms = { othersPlayPause: false, othersSeek: false }
  return {
    mode: 'paused',
    perms,
    canPlayPause: role === 'host',
    canSeek: role === 'host',
    waitForAll: true,
    startMode: { kind: 'buffered', seconds: 10 },
    ...patch,
  }
}

function coverageUpTo(fraction: number, holes: number[] = []): string {
  return encodeCoverage(Array.from({ length: 256 }, (_, i) => i / 256 < fraction && !holes.includes(i)))
}

export function peers(selfRole: Role): PeerView[] {
  const base = {
    exempt: false,
    warnings: [] as PeerWarning[],
    bufferedAheadS: 24,
  }
  return [
    {
      ...base,
      id: 'p-host',
      name: 'Maya',
      role: 'host',
      self: selfRole === 'host',
      path: selfRole === 'host' ? 'none' : 'direct',
      rttMs: selfRole === 'host' ? null : 38,
      phase: 'paused',
      driftMs: 0,
      downBps: 0,
      upBps: 6_200_000,
      havePct: 100,
      coverage: null,
      posS: 600,
    },
    {
      ...base,
      id: 'p-jun',
      name: 'Jun',
      role: 'viewer',
      self: selfRole === 'viewer',
      path: 'direct',
      rttMs: 41,
      phase: 'paused',
      driftMs: 12,
      downBps: 3_100_000,
      upBps: 900_000,
      havePct: 34,
      coverage: coverageUpTo(0.34),
      posS: 600,
    },
    {
      ...base,
      id: 'p-ola',
      name: 'Ola',
      role: 'viewer',
      self: false,
      path: 'relayed',
      rttMs: 142,
      phase: 'buffering',
      driftMs: -380,
      downBps: 1_400_000,
      upBps: 120_000,
      havePct: 18,
      coverage: coverageUpTo(0.25, [12, 13, 14, 40]),
      bufferedAheadS: 2,
      warnings: [{ code: 'slow-download', rateBps: 775_000, needBps: 1_187_500, bufferInS: 40, limitBps: null }],
      posS: 590,
    },
    {
      ...base,
      id: 'p-sam',
      name: 'Sam',
      role: 'viewer',
      self: false,
      path: 'lan',
      rttMs: 3,
      phase: 'paused',
      driftMs: 4,
      downBps: 8_800_000,
      upBps: 2_600_000,
      havePct: 71,
      coverage: coverageUpTo(0.71),
      posS: 600,
    },
  ]
}

export function newcomer(id: string, name: string): PeerView {
  return {
    id,
    name,
    role: 'viewer',
    self: false,
    path: 'direct',
    rttMs: 60,
    phase: 'joining',
    driftMs: null,
    bufferedAheadS: null,
    downBps: 0,
    upBps: 0,
    havePct: 0,
    coverage: null,
    posS: null,
    warnings: [],
    exempt: false,
  }
}

export function timeline(role: Role): CoreEvents['timeline'] {
  const d = FILE.durationS
  return {
    durationS: d,
    done: [
      [0, d * 0.18],
      [d * 0.1, d * 0.34],
      [d * 0.62, d * 0.66],
    ],
    loading: [[d * 0.34, d * 0.37]],
    buffered: [[600, 640]],
    ...(role === 'host'
      ? {
          groupDone: [[0, d * 0.17]] as [number, number][],
          done: [[0, d]] as [number, number][],
        }
      : {}),
  }
}

export function inRoom(role: Role, now: number): StateSlices & Required<Pick<StateSlices, 'session' | 'sync'>> {
  return {
    session: {
      phase: 'in-room',
      role,
      roomId: ROOM_ID,
      fileName: FILE.name,
      fileSize: FILE.size,
      durationS: FILE.durationS,
      media: media(),
    },
    room: {
      roomId: ROOM_ID,
      name: `${role === 'host' ? 'Your' : "Maya's"} room`,
      ...(role === 'host' ? { invite: INVITE } : {}),
      nat: { class: 'CONSISTENT', host: '203.0.113.7' },
      relay: { status: 'ok' },
      admission: 'approve',
      maxMembers: 8,
      pending: role === 'host' ? [{ id: 'p-new', name: 'Priya' }] : [],
    },
    peers: peers(role),
    playback: { posS: 600, durationS: FILE.durationS, paused: true, seeking: false, stalled: false, at: now },
    sync: sync(role),
    timeline: timeline(role),
    transfer: {
      downBps: role === 'host' ? 0 : 3_100_000,
      upBps: role === 'host' ? 6_200_000 : 900_000,
      progress: role === 'host' ? 1 : 0.34,
      missingAheadBytes: 1_200_000_000,
      etaToEofS: role === 'host' ? null : 7_400,
      ...(role === 'host' ? { dupFactor: 1.18 } : {}),
      diskLow: false,
    },
    tracks: tracks(),
    player: player('ready'),
  }
}

export function recentRooms(): RecentRoom[] {
  const day = 86_400_000
  return [
    {
      roomId: 'r-old1',
      name: "Maya's room",
      role: 'viewer',
      fileName: 'Nature.Documentary.S01E03.mkv',
      fileSize: 4_300_000_000,
      lastActiveAt: Date.now() - 2 * 3_600_000,
      progress: 0.62,
      resumable: true,
    },
    {
      roomId: 'r-old2',
      name: 'Your room',
      role: 'host',
      fileName: 'Holiday 2025.mp4',
      fileSize: 1_900_000_000,
      lastActiveAt: Date.now() - 3 * day,
      progress: 1,
      resumable: false,
    },
  ]
}

/** A series in a playlist (ADR 0011): episode 2 plays, 3 prepares (host) or downloads ahead (viewer), 4 waits. */
export function playlist(role: Role, opts: { advance?: boolean } = {}): PlaylistEvent {
  const ep = (n: number): string => `Nature.Documentary.S01E0${String(n)}.1080p.mkv`
  const host = role === 'host'
  const items: PlaylistEvent['items'] = [
    {
      id: 'aaaaaaaaaaa1',
      name: ep(1),
      fileSize: 2_100_000_000,
      durationS: 2_640,
      current: false,
      ...(host ? { host: { state: 'ready', pct: 1 } } : { local: { state: 'complete', progress: 1, downBps: 0 } }),
    },
    {
      id: 'aaaaaaaaaaa2',
      name: ep(2),
      fileSize: 2_300_000_000,
      durationS: 2_710,
      current: true,
      ...(host
        ? { host: { state: 'ready', pct: 1 } }
        : { local: { state: 'downloading', progress: 0.34, downBps: 3_100_000 } }),
    },
    {
      id: 'aaaaaaaaaaa3',
      name: ep(3),
      fileSize: 2_200_000_000,
      durationS: host ? null : 2_590,
      current: false,
      ...(host ? { host: { state: 'hashing', pct: 0.41 } } : { local: { state: 'none', progress: 0, downBps: 0 } }),
    },
    {
      id: 'aaaaaaaaaaa4',
      name: ep(4),
      fileSize: 2_250_000_000,
      durationS: null,
      current: false,
      ...(host ? { host: { state: 'queued', pct: 0 } } : { local: { state: 'none', progress: 0, downBps: 0 } }),
    },
  ]
  return {
    rev: 7,
    currentId: 'aaaaaaaaaaa2',
    autoAdvance: true,
    advance: opts.advance ? { nextId: 'aaaaaaaaaaa3', at: Date.now() + 5000 } : null,
    items: opts.advance && host ? items.map((i) => (i.host ? { ...i, host: { state: 'ready', pct: 1 } } : i)) : items,
  }
}
