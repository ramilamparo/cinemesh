import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { type Mounted, byRole, callsOf, flush, key, mountApp } from '../../test/harness'

// The timeline's own arrow keys (focus on the slider): one seek per press. A held key repeats ~30 times a second;
// an intent each would flood the host (sync.intent is rate-limited per member) and time out.

async function keyRepeat(target: EventTarget, k: string): Promise<boolean> {
  const ev = new KeyboardEvent('keydown', { key: k, repeat: true, bubbles: true, cancelable: true })
  await act(async () => {
    target.dispatchEvent(ev)
    await new Promise((r) => setTimeout(r, 0))
  })
  await flush()
  return ev.defaultPrevented
}

describe('Timeline keys', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('a held arrow key seeks once: its repeats send nothing, here or through the room-wide keys', async () => {
    m = await mountApp('room-host')
    const slider = byRole(m.container, 'slider', 'Playback position')
    slider.focus()
    await key(slider, 'ArrowRight')
    for (let i = 0; i < 30; i++) {
      // still the slider's key: the page does not scroll
      expect(await keyRepeat(slider, 'ArrowRight')).toBe(true)
    }
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'seekRel', deltaS: 5 }])
    // a new press seeks again
    await key(slider, 'ArrowLeft')
    expect(callsOf(m.fake, 'playback.intent')).toEqual([
      { kind: 'seekRel', deltaS: 5 },
      { kind: 'seekRel', deltaS: -5 },
    ])
  })
})
