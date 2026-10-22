// The user's transfer limits (settings uploadLimitKBps, downloadLimitKBps) and the slow-download threshold, shared
// by core and the renderer so that the Room's "below this video's bitrate" note and core's warning agree.

/** A download below this × the video's bitrate warns (sync member) and is what a limit must stay above. */
export const SLOW_RATE_FACTOR = 1.1

/** The largest limit the forms take (Settings and the Room's fields), KiB/s: ~10 GB/s. */
export const LIMIT_MAX_KBPS = 10_000_000

/** A limit setting in KiB/s (the unit the engine has always used) as bytes/s; null or 0 = no limit. */
export function limitBps(kbps: number | null): number | null {
  return kbps ? kbps * 1024 : null
}
