// Checks that the host's source file is byte-for-byte and mtime-identical to what make-data.ts recorded,
// and shows that it is fully allocated random data (not sparse).
//   npx tsx spikes/s2-transport/verify-source.ts
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// not imported from make-data.ts: its top level would rewrite source.json
async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const b of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) h.update(b as Buffer)
  return h.digest('hex')
}

const dir = join(import.meta.dirname, 'data')
const meta = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'))
const src = join(dir, 'source.bin')
const st = statSync(src)
const hash = await sha256(src)
const result = {
  size: st.size,
  allocatedBytes: st.blocks * 512,
  sparse: st.blocks * 512 < st.size,
  mtimeMs: st.mtimeMs,
  mtimeUnchanged: st.mtimeMs === meta.mtimeMs,
  sha256: hash,
  contentUnchanged: hash === meta.sha256,
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.mtimeUnchanged && result.contentUnchanged ? 0 : 1)
