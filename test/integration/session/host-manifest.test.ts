import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Room } from '../../../src/core/net/room.js'
import { MAX_MANIFEST_BYTES } from '../../../src/core/session/viewer-session.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// A manifest viewers would refuse (above MAX_MANIFEST_BYTES, AnnounceSchema) fails hosting with a reason,
// instead of an announce nobody can join. Real files that large are rare (very long all-keyframe video with
// many tracks), so the encoder's output is padded here.

/** pad the encoded manifest to this many bytes (null: leave it alone) */
const pad = vi.hoisted(() => ({ to: null as number | null }))

vi.mock('../../../src/shared/media/manifest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/shared/media/manifest.js')>()
  return {
    ...real,
    encodeManifest: (m: Parameters<typeof real.encodeManifest>[0]): Uint8Array => {
      const bytes = real.encodeManifest(m)
      if (pad.to === null) return bytes
      const padded = new Uint8Array(pad.to)
      padded.set(bytes)
      return padded
    },
  }
})

const roomOf = (m: Member): Room | undefined =>
  (m.manager as unknown as { current: { room: Room } | null }).current?.room

describe.skipIf(!HAVE_FFMPEG)('host session: the manifest size limit', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-host-manifest-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it('a manifest over the limit fails hosting with a reason, and nothing is announced', async () => {
    pad.to = MAX_MANIFEST_BYTES + 1
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: await fixture('mkv-cues.mkv'), subtitlePaths: [] })
    const failed = await host.client.until('session', (s) => s.phase === 'error', 60_000)
    expect(failed.error?.code).toBe('manifest-too-large')
    expect(failed.error?.message).toMatch(/seek index \(4\.0 MB\) is larger than viewers accept \(4\.0 MB\)/)
    expect(roomOf(host)?.latest('session.announce')).toBeNull()
    await host.manager.shutdown()
  })

  it('one exactly at the limit is fine (the limit is what viewers accept)', async () => {
    pad.to = MAX_MANIFEST_BYTES
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: await fixture('mkv-cues.mkv'), subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    const announce = roomOf(host)?.latest('session.announce')?.body as { manifest: { size: number } } | undefined
    expect(announce?.manifest.size).toBe(MAX_MANIFEST_BYTES)
    await host.manager.shutdown()
    pad.to = null
  })
})
