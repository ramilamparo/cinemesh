import { describe, expect, it } from 'vitest'
import * as mediaMap from './media-map.js'
import { FASTSTART_REMUX, MKV_REMUX, MOV_REMUX, TS_REMUX, WEBM_REMUX, remuxCommand, remuxFiles } from './remux.js'
import { CONTAINERS, INTERLEAVES } from './types.js'

const ALL = [FASTSTART_REMUX, MOV_REMUX, MKV_REMUX, WEBM_REMUX, TS_REMUX]

describe('remuxCommand', () => {
  it('gives the remux for a file without a seek index', () => {
    expect(remuxCommand('fmp4', 'linear', 'unknown')).toBe(FASTSTART_REMUX)
    expect(remuxCommand('mkv', 'linear', 'good')).toBe(MKV_REMUX)
    expect(remuxCommand('webm', 'linear', 'unknown')).toBe(WEBM_REMUX)
    expect(remuxCommand('mpegts', 'linear', 'unknown')).toBe(TS_REMUX)
  })

  it('gives the remux for a poorly interleaved file, also one with a seek index', () => {
    expect(remuxCommand('mp4', 'index', 'poor')).toBe(FASTSTART_REMUX)
    expect(remuxCommand('mov', 'index', 'poor')).toBe(MOV_REMUX)
    expect(remuxCommand('mkv', 'index', 'poor')).toBe(MKV_REMUX)
    expect(remuxCommand('webm', 'linear', 'poor')).toBe(WEBM_REMUX)
  })

  it('gives none for a file that needs none', () => {
    for (const container of CONTAINERS) {
      for (const interleave of [...INTERLEAVES.filter((i) => i !== 'poor'), undefined, null]) {
        expect(remuxCommand(container, 'index', interleave)).toBeNull()
      }
    }
  })

  it('gives none where no stream copy is known to fix the file: AVI, generic and unknown containers', () => {
    for (const container of ['avi', 'generic', 'flv', 'toString', '', null, undefined]) {
      expect(remuxCommand(container, 'linear', 'poor')).toBeNull()
    }
  })

  it('takes a missing interleave (older emitters) or seek mode as nothing to fix', () => {
    expect(remuxCommand('mkv', 'linear')).toBe(MKV_REMUX)
    expect(remuxCommand('mkv', undefined, 'poor')).toBe(MKV_REMUX)
    expect(remuxCommand('mkv', undefined, undefined)).toBeNull()
  })

  it('is re-exported where FASTSTART_REMUX used to live', () => {
    expect(mediaMap.FASTSTART_REMUX).toBe(FASTSTART_REMUX)
    expect(mediaMap.remuxCommand).toBe(remuxCommand)
    expect(mediaMap.remuxFiles).toBe(remuxFiles)
  })
})

describe('remux commands', () => {
  it('copy every stream but data tracks, and nothing a shell would expand', () => {
    for (const command of ALL) {
      expect(command).toMatch(/^ffmpeg -i in\.\w+ -map 0 -map -0:d -c copy /)
      expect(command).toMatch(/^[\w .+:-]+$/)
    }
  })

  it('name the file each reads and writes', () => {
    expect(remuxFiles(FASTSTART_REMUX)).toEqual({ input: 'in.mp4', output: 'out.mp4' })
    expect(remuxFiles(MOV_REMUX)).toEqual({ input: 'in.mov', output: 'out.mov' })
    expect(remuxFiles(MKV_REMUX)).toEqual({ input: 'in.mkv', output: 'out.mkv' })
    expect(remuxFiles(WEBM_REMUX)).toEqual({ input: 'in.webm', output: 'out.webm' })
    expect(remuxFiles(TS_REMUX)).toEqual({ input: 'in.ts', output: 'out.mkv' })
    expect(remuxFiles('mkvmerge -o out.mkv in.avi')).toBeNull()
  })
})
