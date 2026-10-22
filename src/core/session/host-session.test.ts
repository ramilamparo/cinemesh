import { describe, expect, it } from 'vitest'
import type { Manifest } from '../../shared/media/types.js'
import { PACED_WINDOW, groupCriticalRanges, uploadCapacityBps } from './host-session.js'

// What host-assigned striping shows every viewer at once (setGroupCriticalRanges), in whole pieces.

const P = 1 << 20

type Ranges = Pick<Manifest, 'fileSize' | 'openCritical' | 'seekCritical'>

describe('groupCriticalRanges', () => {
  // the 60 s LONG mkv-cues.mkv fixture: the head through the first Cluster, and the Cues at the very end
  const mkv: Ranges = {
    fileSize: 15_951_726,
    openCritical: [[0, 1_329_551]],
    seekCritical: [[15_950_517, 15_951_726]],
  }
  const sub = { offset: 15_951_726, length: 9000 }
  const layout = { pieceLength: P, length: 15_951_726 + 9000 }

  it('the open-critical head, the seek index (MKV Cues, read at the first seek) and the subtitle files', () => {
    expect(groupCriticalRanges(mkv, [sub], layout)).toEqual([
      [0, 2 * P],
      [15 * P, layout.length],
    ])
    // the Cues piece is critical on its own account, not only through the subtitle file after it
    expect(groupCriticalRanges(mkv, [], { pieceLength: P, length: mkv.fileSize })).toEqual([
      [0, 2 * P],
      [15 * P, mkv.fileSize],
    ])
  })

  it('a file that plays only once complete is striped: only its subtitle files are shown to everyone', () => {
    // fMP4 without sidx: open-critical from end to end
    const fmp4: Ranges = { fileSize: 15_954_622, openCritical: [[0, 15_954_622]], seekCritical: [] }
    const files = { pieceLength: P, length: fmp4.fileSize + 9000 }
    expect(groupCriticalRanges(fmp4, [{ offset: fmp4.fileSize, length: 9000 }], files)).toEqual([
      [15 * P, files.length],
    ])
    expect(groupCriticalRanges(fmp4, [], { pieceLength: P, length: fmp4.fileSize })).toEqual([])
  })
})

describe("uploadCapacityBps (the feasibility line's upload)", () => {
  it('is the peak measured upload until the pacer has been steady for 10 s, then its best rate of those 10 s', () => {
    expect(uploadCapacityBps([], 0)).toBeNull()
    expect(uploadCapacityBps([], 3e6)).toBe(3e6)
    const steady = Array.from({ length: PACED_WINDOW - 1 }, (_, k) => 2e6 + k * 1000)
    expect(uploadCapacityBps(steady, 3e6)).toBe(3e6) // 9 s: not yet
    expect(uploadCapacityBps([...steady, 2.1e6], 3e6)).toBe(2.1e6) // the uplink carries 2.1 MB/s, not the 3 burst
    expect(uploadCapacityBps([5e6, ...steady, 2.1e6], 3e6)).toBe(2.1e6) // only the last 10 s
  })
})
