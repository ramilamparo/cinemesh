// Stream-copy remuxes (no re-encoding) the UI suggests to a host whose file streams poorly: no seek index ('linear':
// a viewer needs everything from the start up to where it plays), an open that reads all of it (needsFullDownload),
// or audio stored far from its video (interleave 'poor'). Each was run with FFmpeg 9 on generated files and its output
// indexed 'index' and 'good', with every track kept (test/integration/media/remux.test.ts, ADR 0004 §8.4). All keep
// every video, audio, subtitle and attachment track (-map 0) and drop data tracks (-map -0:d: timecode, SCTE-35, ID3),
// which no player uses and MP4 and Matroska cannot hold. Without -map FFmpeg keeps one audio and one subtitle track.

/**
 * fMP4, or a poorly interleaved MP4, into an MP4 with moov in front and no fragments. The mov demuxer reads samples in
 * time order, so the copy comes out interleaved however far apart they were (all audio after all video too).
 */
export const FASTSTART_REMUX = 'ffmpeg -i in.mp4 -map 0 -map -0:d -c copy -movflags +faststart out.mp4'

/** The same for QuickTime: a .mov keeps codecs MP4 cannot hold (PCM, ProRes). */
export const MOV_REMUX = 'ffmpeg -i in.mov -map 0 -map -0:d -c copy -movflags +faststart out.mov'

/**
 * Matroska into Matroska: FFmpeg writes Cues into a seekable output. Its matroska demuxer reads in file order, so
 * audio stored further than FFmpeg's default 10 s (max_interleave_delta) from its video stays that far behind; 60 s
 * fixes up to that and holds at most 60 s of media in memory (0 would wait for a packet of every stream, a sparse
 * subtitle track's too: up to the whole file).
 */
export const MKV_REMUX = 'ffmpeg -i in.mkv -map 0 -map -0:d -c copy -max_interleave_delta 60000000 out.mkv'

/** The same for WebM, whose streams WebM holds as they are. */
export const WEBM_REMUX = 'ffmpeg -i in.webm -map 0 -map -0:d -c copy -max_interleave_delta 60000000 out.webm'

/** MPEG-TS has no index of any kind: into Matroska, with Cues. It fails on DVB teletext, which Matroska cannot hold. */
export const TS_REMUX = 'ffmpeg -i in.ts -map 0 -map -0:d -c copy -max_interleave_delta 60000000 out.mkv'

// None for AVI: it stores no pts, so a copy of B-frames (x264, XviD) stops at "Can't write packet with unknown
// timestamp", and -fflags +genpts puts H.264 B-pyramid frames out of order. Nor for 'generic' (unknown containers).
const BY_CONTAINER = new Map<string, string>([
  ['fmp4', FASTSTART_REMUX],
  ['mp4', FASTSTART_REMUX],
  ['mov', MOV_REMUX],
  ['mkv', MKV_REMUX],
  ['webm', WEBM_REMUX],
  ['mpegts', TS_REMUX],
])

/**
 * The remux for a file the index found 'linear' or 'poor' (session.media's container, seekMode and interleave), or
 * null: the file needs none, or no stream copy is known to fix it (AVI, generic containers).
 */
export function remuxCommand(
  container: string | null | undefined,
  seekMode: string | null | undefined,
  interleave?: string | null,
): string | null {
  if (seekMode !== 'linear' && interleave !== 'poor') return null
  return (container ? BY_CONTAINER.get(container) : undefined) ?? null
}

/** The file names a remux command reads and writes (in.ts → out.mkv), for the words around it. */
export function remuxFiles(command: string): { input: string; output: string } | null {
  const m = /^ffmpeg -i (\S+) .* (\S+)$/.exec(command)
  return m?.[1] !== undefined && m[2] !== undefined ? { input: m[1], output: m[2] } : null
}
