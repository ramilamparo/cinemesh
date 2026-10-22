import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { attackHost } from './hostile-member.js'

// Any admitted member can open the bt lane and send the host whatever bytes it likes. The host runs in a child
// process (hostile-member.ts): before patches/bencode+4.0.1.patch a negative string length in a BEP 10 handshake
// stopped its event loop for good, and before the extension guard in patches/bittorrent-protocol+5.0.9.patch an
// empty ut_metadata message threw out of the wire's parser (the core's uncaughtException handler, a 'fatal').

const dir = mkdtempSync(join(tmpdir(), 'wt-hostile-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('TransferEngine host with a hostile member on the bt lane', () => {
  it('ticks on, drops that wire, and keeps serving the viewer when a member sends malformed BEP 10 messages', async () => {
    const report = await attackHost(dir, { silenceLimitMs: 5000, timeoutMs: 90_000 })
    const at0 = report.events[0]?.at ?? 0
    const summary = JSON.stringify({
      ...report,
      events: report.events.filter((e) => e.t !== 'verified').map((e) => ({ ...e, at: e.at - at0 })),
    })
    expect(report.killed, summary).toBeNull()
    expect(
      report.events.filter((e) => e.t === 'uncaught' || e.t === 'failed'),
      summary,
    ).toEqual([])
    // its timers kept firing all along: nothing it was sent kept its event loop busy for even 2 s
    expect(report.maxSilenceMs, summary).toBeLessThan(2000)
    // what it was sent, in order: the wire parsed on past the malformed messages (it answered 'interested'), and
    // the one its ut_metadata extension throws on (an empty message) got the lane dropped
    expect(
      report.events.filter((e) => e.t !== 'verified').map((e) => (e.t === 'sent' ? e.what : e.t)),
      summary,
    ).toEqual([
      'handshake, negative string length',
      'handshake, nested 100 000 deep',
      'handshake, string past the end',
      'handshake, valid',
      'ut_metadata, negative string length',
      'ut_metadata, nested 100 000 deep',
      'answered',
      'ut_metadata, empty',
      'dropped',
      'done',
    ])
    // and the viewer kept downloading from it after that
    const droppedAt = report.events.find((e) => e.t === 'dropped')?.at ?? Number.POSITIVE_INFINITY
    expect(report.events.filter((e) => e.t === 'verified' && e.at > droppedAt).length, summary).toBeGreaterThanOrEqual(
      4,
    )
    expect(report.exitCode, summary).toBe(0)
  })
})
