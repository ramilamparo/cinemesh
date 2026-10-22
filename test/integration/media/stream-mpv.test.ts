import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MPV_STREAM_OPTS } from '../../../src/core/media/mpv-stream-opts.js'
import { StreamServer } from '../../../src/core/media/stream-server.js'
import { FakeSource } from '../../../src/core/media/testing/fake-source.js'
import { type FixtureName, HAVE_FFMPEG, HAVE_MPV, fixture } from './fixtures.js'

// mpv reads a fixture through the stream server while a fake swarm verifies pieces one at a time:
// the piece a reader is blocked on first, otherwise the next one in file order.

const PIECE = 64 * 1024
const RELEASE_EVERY_MS = 15
const MPV_TIMEOUT_MS = 60_000

interface Run {
  code: number | null
  output: string
}

function runMpv(url: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'mpv',
      [
        '--no-config',
        '--vo=null',
        '--ao=null',
        '--frames=50',
        '--terminal=yes',
        '--msg-level=all=warn',
        '--ytdl=no',
        '--load-scripts=no',
        ...MPV_STREAM_OPTS,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), MPV_TIMEOUT_MS)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

describe.skipIf(!HAVE_FFMPEG || !HAVE_MPV)('mpv plays through the stream server', () => {
  const cases: FixtureName[] = ['mkv-cues.mkv', 'mkv-tail.mkv', 'mp4-tailmoov.mp4', 'fmp4-sidx.mp4', 'avi.avi']
  for (const name of cases) {
    it(`${name} while pieces trickle in`, async () => {
      const path = await fixture(name)
      const fh = await open(path, 'r')
      const size = (await fh.stat()).size
      const source = new FakeSource(
        [{ index: 0, name: basename(path), offset: 0, length: size }],
        PIECE,
        async (abs, len) => {
          const buf = new Uint8Array(len)
          const { bytesRead } = await fh.read(buf, 0, len, abs)
          return buf.subarray(0, bytesRead)
        },
      )
      let cursor = 0
      const timer = setInterval(() => {
        const blocked = source.blocked.find((i) => !source.has(i))
        if (blocked !== undefined) source.release(blocked)
        else {
          while (cursor < source.pieceCount && source.has(cursor)) cursor++
          if (cursor < source.pieceCount) source.release(cursor)
        }
      }, RELEASE_EVERY_MS)
      const server = await StreamServer.listen(source)
      try {
        const run = await runMpv(server.url(0))
        expect(run.code, run.output).toBe(0)
        // mpv got ahead of the swarm and waited, more than once, without giving up
        expect(new Set(source.blocked).size).toBeGreaterThan(1)
        expect(source.reads.length).toBeGreaterThan(0)
      } finally {
        clearInterval(timer)
        await server.close()
        await fh.close()
      }
      expect(source.waiting).toBe(0)
      expect(source.readersOpen).toBe(0)
    })
  }
})
