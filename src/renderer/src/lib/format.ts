// Display formatting. Sizes use decimal units (1 GB = 10^9 bytes), like the OS file managers we target.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '–'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '–'
  return `${formatBytes(Math.max(0, bytesPerSec))}/s`
}

/** Network speeds are quoted in bits, the unit ISPs and speed tests use. */
export function formatMbit(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '?'
  const mbit = (bytesPerSec * 8) / 1e6
  return mbit >= 10 ? mbit.toFixed(0) : mbit.toFixed(1)
}

/** 0:07, 12:34, 1:02:03 */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–:––'
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Rough remaining time: "45 s", "3 min", "1 h 20 min". */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '–'
  const pct = Math.min(100, Math.max(0, fraction * 100))
  return `${pct >= 99.5 && pct < 100 ? '99' : pct.toFixed(0)} %`
}

export function formatDrift(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±'
  const abs = Math.abs(ms)
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)} s` : `${sign}${Math.round(abs)} ms`
}
