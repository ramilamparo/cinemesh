import { describe, expect, it } from 'vitest'
import { hdrLabel, hdrStatus } from './hdr-status.js'

describe('hdrStatus', () => {
  it('reports unknown before a video is loaded', () => {
    expect(hdrStatus({})).toEqual({ source: 'unknown', output: 'unknown', gpuContext: null, hwdec: null })
  })

  it('reports an SDR source as SDR whatever the target', () => {
    const s = hdrStatus({
      'video-params': { gamma: 'bt.1886', 'sig-peak': 0 },
      'video-target-params': { gamma: 'bt.1886' },
      'current-gpu-context': 'waylandvk',
      'hwdec-current': 'no',
    })
    expect(s).toEqual({ source: 'sdr', output: 'sdr', gpuContext: 'waylandvk', hwdec: 'no' })
    expect(hdrLabel(s)).toBe('SDR')
  })

  it('reports PQ into an SDR target as tone-mapped', () => {
    const s = hdrStatus({
      'video-params': { gamma: 'pq', 'max-cll': 1000 },
      'video-target-params': { gamma: 'srgb', 'max-luma': 203 },
      'current-gpu-context': 'x11vk',
      'hwdec-current': 'vaapi',
    })
    expect(s).toEqual({
      source: 'hdr',
      output: 'tonemapped',
      maxCll: 1000,
      targetPeak: 203,
      gpuContext: 'x11vk',
      hwdec: 'vaapi',
    })
    expect(hdrLabel(s)).toBe('HDR → SDR (tone-mapped)')
  })

  it('reports HLG into a PQ target as passthrough', () => {
    const s = hdrStatus({
      'video-params': { gamma: 'hlg' },
      'video-target-params': { gamma: 'pq', 'sig-peak': 4.926 },
    })
    expect(s.output).toBe('passthrough')
    expect(s.targetPeak).toBe(1000)
    expect(hdrLabel(s)).toBe('HDR (passthrough)')
  })

  it('leaves output unknown while the target is not known yet', () => {
    expect(hdrStatus({ 'video-params': { gamma: 'pq' } }).output).toBe('unknown')
  })
})
