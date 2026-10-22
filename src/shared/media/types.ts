// Media index model shared by the host's index builder, the manifest codec and MediaMap (renderer too).
// Times are milliseconds on the player's timeline: 0 is the first frame (mpv rebases the start time),
// so a container start time is kept apart in `startMs`. Byte offsets are positions inside the video file.

export const CONTAINERS = ['mkv', 'webm', 'mp4', 'mov', 'fmp4', 'avi', 'mpegts', 'generic'] as const
export type Container = (typeof CONTAINERS)[number]

/** 'index': the player can seek straight to a keyframe; 'linear': it may read from the start. */
export const SEEK_MODES = ['index', 'linear'] as const
export type SeekMode = (typeof SEEK_MODES)[number]

export const INTERLEAVES = ['good', 'poor', 'unknown'] as const
export type Interleave = (typeof INTERLEAVES)[number]

export const TRACK_TYPES = ['video', 'audio', 'subtitle', 'other'] as const
export type TrackType = (typeof TRACK_TYPES)[number]

export const HDR_KINDS = ['none', 'pq', 'hlg'] as const
export type HdrKind = (typeof HDR_KINDS)[number]

/** File bytes, end exclusive. */
export type ByteRange = readonly [start: number, end: number]

/** A seek point: presentation time (player timeline, ms) and the byte where reading must start. */
export type KeyPoint = readonly [ms: number, byte: number]

export interface TrackInfo {
  id: number
  type: TrackType
  codec: string
  lang: string
  name: string
  isDefault: boolean
  forced: boolean
  hdr: HdrKind
  channels: number
  width: number
  height: number
}

/** Byte positions of one audio track, for files whose audio is stored far from its video. */
export interface AudioIndex {
  trackId: number
  points: KeyPoint[]
}

export interface ExternalSub {
  fileIndex: number
  name: string
  lang: string
  title: string
}

export interface MediaIndex {
  fileSize: number
  container: Container
  seekMode: SeekMode
  interleave: Interleave
  multiSegment: boolean
  durationMs: number
  startMs: number
  avgBytesPerSec: number
  /** Strictly increasing times, non-decreasing bytes, at least KEYFRAME_MIN_GAP_MS apart. */
  keyframes: KeyPoint[]
  openCritical: ByteRange[]
  seekCritical: ByteRange[]
  tracks: TrackInfo[]
  audioIndexes?: AudioIndex[]
}

export interface Manifest extends MediaIndex {
  version: number
  infoHash: Uint8Array
  videoFileIndex: number
  pieceLength: number
  externalSubs: ExternalSub[]
}

export const KEYFRAME_MIN_GAP_MS = 250
