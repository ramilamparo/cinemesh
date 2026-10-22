import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from '../../../src/core/net/crypto.js'
import { encodeInvite } from '../../../src/core/net/invite.js'
import type { Room } from '../../../src/core/net/room.js'
import { Harness, memberIds, waitFor } from './helpers.js'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

describe('rooms on a local testnet', () => {
  it('1 host + 5 viewers form a full mesh and agree on the members', async () => {
    h = await Harness.start()
    const host = await h.host('Host')
    const invite = host.invite().code
    const viewers: Room[] = []
    for (let i = 1; i <= 5; i++) viewers.push(await h.viewer(invite, `V${String(i)}`))
    const all = [host, ...viewers]

    await waitFor(() => viewers.every((v) => v.state().phase === 'in-room'), 20_000, 'all admitted')
    await waitFor(() => all.every((r) => r.peers().length === 5), 20_000, 'full mesh')
    const expected = memberIds(host)
    expect(expected).toHaveLength(6)
    for (const v of viewers) expect(memberIds(v)).toEqual(expected)
    for (const v of viewers) expect(v.peers().find((p) => p.isHost)?.name).toBe('Host')
    expect(host.members().find((m) => m.self)?.isHost).toBe(true)
  })

  it('denies the 5th member with full when the cap is 4', async () => {
    h = await Harness.start()
    const host = await h.host('Host', { maxMembers: 4 })
    const invite = host.invite().code
    const viewers: Room[] = []
    for (let i = 1; i <= 3; i++) viewers.push(await h.viewer(invite, `V${String(i)}`))
    await waitFor(() => viewers.every((v) => v.state().phase === 'in-room'), 20_000, 'three admitted')
    const fifth = await h.viewer(invite, 'V4')
    await waitFor(() => fifth.state().phase === 'denied', 20_000, 'fifth denied')
    expect(fifth.state().denyReason).toBe('full')
    expect(host.members()).toHaveLength(4)
  })

  it('reports why the host cannot be reached, with a hint', async () => {
    h = await Harness.start()
    const nobody = encodeInvite({ roomSecret: randomBytes(32), hostKey: randomBytes(32), relayKey: null, name: '' })
    const viewer = await h.viewer(nobody, 'Lonely')
    await waitFor(() => viewer.state().hostError !== undefined, 20_000, 'host error reported')
    expect(viewer.state().hostError).toEqual({ code: 'PEER_NOT_FOUND', hint: 'The host is not online right now.' })
    expect(viewer.state().phase).toBe('joining')
  })
})
