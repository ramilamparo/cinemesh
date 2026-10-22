// Generates the host's source file (random bytes, not sparse) and hashes it once into a cached .torrent.
//   npx tsx spikes/s2-transport/make-data.ts [sizeBytes]
import { createHash, randomFillSync } from 'node:crypto'
import { createReadStream, existsSync, openSync, closeSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

const dir = join(import.meta.dirname, 'data')
const src = join(dir, 'source.bin')
const torrentPath = join(dir, 'source.torrent')
const size = Number(process.argv[2] ?? 2 * 1024 ** 3 + 12345) // 2 GiB + an odd tail piece

if (!existsSync(src) || statSync(src).size !== size) {
  const t = Date.now()
  const fd = openSync(src, 'w')
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024)
  for (let done = 0; done < size; ) {
    const n = Math.min(chunk.length, size - done)
    randomFillSync(chunk, 0, n)
    writeSync(fd, chunk, 0, n)
    done += n
  }
  closeSync(fd)
  rmSync(torrentPath, { force: true }) // new random content: the cached .torrent is stale
  console.log(`wrote ${size} random bytes in ${Date.now() - t} ms`)
}

export async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const b of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) h.update(b as Buffer)
  return h.digest('hex')
}

if (!existsSync(torrentPath)) {
  const t = Date.now()
  const buf = await new Promise<Buffer>((resolve, reject) =>
    createTorrent(
      src,
      { name: 'source.bin', pieceLength: 1024 * 1024, private: true, announceList: [], urlList: [], createdBy: 'S2' },
      (err: Error | null, b: Buffer) => (err ? reject(err) : resolve(b)),
    ),
  )
  writeFileSync(torrentPath, buf)
  console.log(`hashed into ${torrentPath} in ${Date.now() - t} ms`)
}

const parsed = await parseTorrent(await import('node:fs').then((fs) => fs.readFileSync(torrentPath)))
const st = statSync(src)
const meta = { size: st.size, mtimeMs: st.mtimeMs, sha256: await sha256(src), infoHash: parsed.infoHash, pieces: parsed.pieces.length }
writeFileSync(join(dir, 'source.json'), JSON.stringify(meta, null, 2))
console.log(meta)
