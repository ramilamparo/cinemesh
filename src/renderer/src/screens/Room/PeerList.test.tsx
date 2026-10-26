import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fx from '../../mock/fixtures'
import { type Mounted, flush, mountApp, text } from '../../test/harness'

/** A member's row in the peer list. */
function row(m: Mounted, name: string): HTMLElement {
  const li = m.container.querySelector<HTMLElement>(`li[aria-label="${name}"]`)
  if (!li) throw new Error(`no row for ${name}`)
  return li
}

const warningLines = (li: HTMLElement): HTMLElement[] => [...li.querySelectorAll<HTMLElement>('li')]

describe('PeerList warnings', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
    vi.restoreAllMocks()
  })

  it('says what is wrong in words, most severe first, hash failures in the danger tone', async () => {
    const consoleError = vi.spyOn(console, 'error')
    m = await mountApp('room-host')
    expect(text(row(m, 'Ola'))).toContain('Download too slow (6.2 of 9.5 Mbit/s); may buffer in ~40 s')

    const peers = fx.peers('host').map((p) =>
      p.name === 'Sam'
        ? {
            ...p,
            warnings: [
              { code: 'hash-fails', total: 5 } as const,
              { code: 'behind', behindS: 1.4 } as const,
              { code: 'frame-drops' } as const,
            ],
          }
        : p,
    )
    act(() => m?.fake.emit('peers', peers))
    await flush()
    const lines = warningLines(row(m, 'Sam'))
    expect(lines.map((li) => text(li))).toEqual([
      expect.stringContaining('does not match the video (5 failed checks)'),
      '⚠ 1.4 s behind the host',
      '⚠ Dropping frames; playback may stutter',
    ])
    expect(lines.map((li) => li.dataset.tone)).toEqual(['danger', 'warn', 'warn'])
    for (const code of ['slow-download', 'frame-drops', 'hash-fails']) expect(text(m.container)).not.toContain(code)
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/)
  })

  it('tags a viewer the host feeds first while it catches up (ADR 0012)', async () => {
    m = await mountApp('room-host')
    expect(text(row(m, 'Sam'))).not.toContain('Catching up')
    const peers = fx.peers('host').map((p) => (p.name === 'Sam' ? { ...p, catchingUp: true } : p))
    act(() => m?.fake.emit('peers', peers))
    await flush()
    expect(text(row(m, 'Sam'))).toContain('Catching up')
    expect(text(row(m, 'Ola'))).not.toContain('Catching up')
  })
})
