import type { PlayerEvent } from '../../shared/ipc/core.js'

export type HdrStatus = PlayerEvent['hdr']

/** The observed mpv properties this is derived from; unavailable ones are undefined or null. */
export interface HdrInputs {
  'video-params'?: unknown
  'video-target-params'?: unknown
  'current-gpu-context'?: unknown
  'hwdec-current'?: unknown
}

const HDR_GAMMAS = new Set(['pq', 'hlg'])

/**
 * Source is HDR when video-params/gamma is pq or hlg; output is passthrough when the target is too
 * (plan §4.4). An SDR source reports output 'sdr'; anything missing reports 'unknown'.
 */
export function hdrStatus(p: HdrInputs): HdrStatus {
  const video = asRecord(p['video-params'])
  const target = asRecord(p['video-target-params'])
  const srcGamma = str(video?.gamma)
  const dstGamma = str(target?.gamma)
  const source = srcGamma === null ? 'unknown' : HDR_GAMMAS.has(srcGamma) ? 'hdr' : 'sdr'
  let output: HdrStatus['output'] = 'unknown'
  if (source === 'sdr') output = 'sdr'
  else if (source === 'hdr' && dstGamma !== null) output = HDR_GAMMAS.has(dstGamma) ? 'passthrough' : 'tonemapped'

  const status: HdrStatus = {
    source,
    output,
    gpuContext: str(p['current-gpu-context']),
    hwdec: str(p['hwdec-current']),
  }
  const maxCll = positive(video?.['max-cll'])
  // max-luma is the target display's peak in cd/m²; sig-peak is relative to SDR white (203 cd/m²).
  const targetPeak = positive(target?.['max-luma']) ?? scaled(positive(target?.['sig-peak']), 203)
  if (maxCll !== null) status.maxCll = maxCll
  if (targetPeak !== null) status.targetPeak = targetPeak
  return status
}

/** "HDR → SDR (tone-mapped)" and friends, for logs and the UI. */
export function hdrLabel(h: HdrStatus): string {
  if (h.source === 'unknown') return 'Unknown'
  if (h.source === 'sdr') return 'SDR'
  if (h.output === 'passthrough') return 'HDR (passthrough)'
  if (h.output === 'tonemapped') return 'HDR → SDR (tone-mapped)'
  return 'HDR'
}

export function sameHdr(a: HdrStatus, b: HdrStatus): boolean {
  return (
    a.source === b.source &&
    a.output === b.output &&
    a.maxCll === b.maxCll &&
    a.targetPeak === b.targetPeak &&
    a.gpuContext === b.gpuContext &&
    a.hwdec === b.hwdec
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function scaled(v: number | null, k: number): number | null {
  return v === null ? null : Math.round(v * k)
}
