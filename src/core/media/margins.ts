// How much media after the headers is open-critical. The plan's fixed 256 KiB was too little in our
// mpv 0.41 runs (README, "Open-critical margin"): before it applies `start=`, mpv reads on from the
// first media byte (lavf stream probing for MP4/AVI, demuxer read-ahead for MKV) and needed about
// 1 MiB of a 600 kbit/s file. We keep ~5 s of media (ffmpeg's default analyzeduration), at least
// 1 MiB and at most 8 MiB (S4's fallback). S4 measures the final values.

const MIB = 1024 * 1024
export const HEAD_MARGIN_MIN = 1 * MIB
export const HEAD_MARGIN_MAX = 8 * MIB
export const HEAD_MARGIN_SECONDS = 5

export function headMargin(avgBytesPerSec: number): number {
  return Math.round(Math.min(HEAD_MARGIN_MAX, Math.max(HEAD_MARGIN_MIN, avgBytesPerSec * HEAD_MARGIN_SECONDS)))
}
