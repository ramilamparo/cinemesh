import { describe, expect, it } from 'vitest'
import { hintFor, natClass, natReport, withTimeout } from './diagnostics.js'
import { NET_ERRORS } from './errors.js'

describe('NAT class', () => {
  it('maps the DHT view: not firewalled → OPEN, port 0 → RANDOM, else CONSISTENT', () => {
    expect(natClass({ host: '1.2.3.4', port: 5000, firewalled: false })).toBe('OPEN')
    expect(natClass({ host: '1.2.3.4', port: 0, firewalled: true })).toBe('RANDOM')
    expect(natClass({ host: '1.2.3.4', port: 5000, firewalled: true })).toBe('CONSISTENT')
    expect(natClass({ host: null, port: 0, firewalled: true })).toBe('UNKNOWN')
  })

  it('reports UNKNOWN with the UDP hint when not bootstrapped', () => {
    const report = natReport({ host: null, port: 0, firewalled: true }, false)
    expect(report).toMatchObject({ class: 'UNKNOWN', bootstrapped: false })
    expect(report.hint).toMatch(/UDP blocked/)
  })

  it('recommends a relay behind a RANDOM NAT, with or without udpPort (a forward does not change RANDOM)', () => {
    for (const udpPort of [49800, null]) {
      const hint = natReport({ host: '1.2.3.4', port: 0, firewalled: true }, true, udpPort).hint
      expect(hint).toMatch(/Add a relay\.$/)
      expect(hint).not.toMatch(/forward/i)
    }
  })

  it('flags an unforwarded udpPort behind a CONSISTENT NAT, and nothing once it shows OPEN', () => {
    expect(natReport({ host: '1.2.3.4', port: 7, firewalled: true }, true, 49800, 49800).hint).toBe(
      'UDP 49800 does not answer from the internet yet. Check the port forward on your router.',
    )
    expect(natReport({ host: '1.2.3.4', port: 7, firewalled: true }, true).hint).toBeNull()
    expect(natReport({ host: '1.2.3.4', port: 49800, firewalled: false }, true, 49800, 49800).hint).toBeNull()
  })

  it('does not blame the router for a udpPort the DHT could not bind (dht-rpc took another one)', () => {
    for (const bound of [49801, null]) {
      const hint = natReport({ host: '1.2.3.4', port: 7, firewalled: true }, true, 49800, bound).hint
      expect(hint).toBe(
        'UDP 49800 was already in use, so another port was used and the port forward does not apply. Close what uses it, or choose another port.',
      )
    }
  })
})

describe('hints', () => {
  it('maps hyperdht and our own codes', () => {
    expect(hintFor('HOLEPUNCH_DOUBLE_RANDOMIZED_NATS')).toBe(
      'Both of you have strict NATs, so you cannot connect directly: add a relay.',
    )
    expect(hintFor(NET_ERRORS.authFailed)).toMatch(/invite/)
    expect(hintFor('SOMETHING_ELSE')).toBeNull()
    expect(hintFor(null)).toBeNull()
  })

  it('says HOLEPUNCH_ABORTED is retried and only a relay helps two strict NATs (hyperdht reports both causes so)', () => {
    expect(hintFor('HOLEPUNCH_ABORTED')).toBe(
      'A direct connection could not be made yet; it is retried. If both of you have strict NATs, only a relay helps.',
    )
  })

  it('does not promise a 15 s wait for NO_BOOTSTRAP: the test gives up as soon as bootstrap does', () => {
    expect(hintFor('NO_BOOTSTRAP')).toBe('No answer from the network. Is UDP blocked by a firewall?')
  })
})

describe('withTimeout', () => {
  it('returns the fallback when the promise is too slow', async () => {
    expect(await withTimeout(new Promise<number>(() => undefined), 10, -1)).toBe(-1)
    expect(await withTimeout(Promise.resolve(1), 1000, -1)).toBe(1)
  })
})
