#!/usr/bin/env node
// fetch-mpv: downloads the official mpv builds that the Windows and macOS packages bundle (plan §4.4 Binaries),
// checks each archive against the SHA-256 pinned in scripts/mpv-assets.json, and unpacks it into
// vendor/mpv/<os>-<arch>/. electron-builder copies that folder to <resources>/mpv (electron-builder.yml, mac and win
// extraResources), which is where src/main/mpv-locate.ts bundledMpvPath() looks:
//   win-x64    vendor/mpv/win-x64/mpv.exe            (+ mpv.com, vulkan-1.dll)
//   mac-arm64  vendor/mpv/mac-arm64/mpv.app/Contents/MacOS/mpv
//   mac-x64    vendor/mpv/mac-x64/mpv.app/Contents/MacOS/mpv
// Linux packages use the system or Flatpak mpv, so there is nothing to fetch for Linux.
//
// Usage: node scripts/fetch-mpv.mjs [--platform <list>] [--force] [--source]
//   --platform  comma-separated: win-x64, mac-arm64, mac-x64, all, or current (the default: this machine's OS/arch)
//   --force     unpack again even when vendor/mpv/<platform> is up to date
//   --source    also fetch the pinned mpv source tarball into vendor/mpv/source/ (attached to releases for the GPL)
//
// Requirements: Node >= 24 and HTTPS access to github.com; nothing else. Archives are unpacked in-process (zip with
// zlib.inflateRawSync, tar.gz with zlib.gunzipSync and a small ustar/pax reader), so the script behaves the same on
// the Linux, macOS and Windows runners and any host can unpack any platform's build. Behind a proxy, set
// NODE_USE_ENV_PROXY=1 together with HTTPS_PROXY.
//
// Idempotent: downloads are cached in vendor/mpv/.cache/ and checked against the pinned SHA-256 whenever they are
// used. vendor/mpv/.stamps/<platform>.json records the SHA-256 of every unpacked file; each run re-hashes the
// unpacked tree and skips the platform only when it still matches the pinned asset exactly.
// Exit codes: 0 ok, 1 failure (download, SHA-256 mismatch, unexpected archive contents), 2 usage error.
/* global fetch, AbortSignal */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const ASSETS_FILE = join(import.meta.dirname, 'mpv-assets.json')
const VENDOR = join(ROOT, 'vendor', 'mpv')
const CACHE = join(VENDOR, '.cache')
const STAMPS = join(VENDOR, '.stamps')
const SOURCE_DIR = join(VENDOR, 'source')
/** Bump when the unpacking rules change, so existing vendor folders are rebuilt. */
const LAYOUT = 1
const ALL = ['win-x64', 'mac-arm64', 'mac-x64']
const USAGE =
  'usage: node scripts/fetch-mpv.mjs [--platform win-x64,mac-arm64,mac-x64|all|current] [--force] [--source]'

class FetchError extends Error {}

const log = (label, msg) => console.log(`[fetch-mpv] ${label}: ${msg}`)
const rel = (p) => relative(ROOT, p) || '.'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const mib = (n) => `${(n / 2 ** 20).toFixed(1)} MiB`

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.error(e instanceof FetchError ? `[fetch-mpv] error: ${e.message}` : e)
    process.exitCode = 1
  },
)

async function main() {
  let args
  try {
    ;({ values: args } = parseArgs({
      options: {
        platform: { type: 'string', multiple: true },
        force: { type: 'boolean', default: false },
        source: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }))
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const manifest = JSON.parse(await readFile(ASSETS_FILE, 'utf8'))
  const platforms = resolvePlatforms(args.platform ?? ['current'])
  if (platforms === null) return 2

  const summary = []
  for (const id of platforms) {
    const asset = manifest.platforms[id]
    if (!asset) throw new FetchError(`${id} is missing from ${rel(ASSETS_FILE)}`)
    await fetchPlatform(id, asset, manifest.version, args.force)
    summary.push(`${asset.sha256}  ${posix.basename(new URL(asset.url).pathname)}  -> ${rel(join(VENDOR, id))}`)
  }
  if (args.source) {
    const s = manifest.source
    await download(s.url, s.sha256, s.size, 'source', join(SOURCE_DIR, s.file))
    summary.push(`${s.sha256}  ${s.file}  -> ${rel(join(SOURCE_DIR, s.file))}`)
  }
  for (const line of summary) console.log(`[fetch-mpv] ok ${line}`)
  return 0
}

/** Expands the --platform values; null after printing a usage error. */
function resolvePlatforms(values) {
  const out = []
  for (const v of values
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (v === 'all') out.push(...ALL)
    else if (v === 'current') {
      const here = currentPlatform()
      if (here) out.push(here)
      else log(`${process.platform}-${process.arch}`, 'no bundled mpv here (Linux uses the system or Flatpak mpv)')
    } else if (ALL.includes(v)) out.push(v)
    else {
      console.error(`unknown platform '${v}'\n${USAGE}`)
      return null
    }
  }
  return [...new Set(out)]
}

function currentPlatform() {
  const key = `${process.platform}-${process.arch}`
  return { 'win32-x64': 'win-x64', 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64' }[key] ?? null
}

async function fetchPlatform(id, asset, version, force) {
  const dest = join(VENDOR, id)
  const stampFile = join(STAMPS, `${id}.json`)
  const want = { layout: LAYOUT, version, url: asset.url, sha256: asset.sha256 }
  if (!force && (await upToDate(stampFile, want, dest))) {
    log(id, `up to date (${rel(dest)}, every file matches ${rel(stampFile)})`)
    return
  }
  const name = posix.basename(new URL(asset.url).pathname)
  const archive = await download(asset.url, asset.sha256, asset.size, id, join(CACHE, name))
  const entries = unpack(id, asset, archive)

  const tmp = join(VENDOR, `.tmp-${id}-${String(process.pid)}`)
  await rm(tmp, { recursive: true, force: true })
  await writeTree(tmp, entries)
  const binary = join(tmp, ...asset.binary.split('/'))
  if (!existsSync(binary)) throw new FetchError(`${id}: ${asset.binary} is not in ${name}`)
  checkArch(id, asset, await readFile(binary))

  await rm(dest, { recursive: true, force: true })
  await rename(tmp, dest)
  const files = await hashTree(dest)
  await mkdir(STAMPS, { recursive: true })
  await writeFile(stampFile, `${JSON.stringify({ ...want, unpackedAt: new Date().toISOString(), files }, null, 2)}\n`)
  log(id, `unpacked ${String(Object.keys(files).length)} files into ${rel(dest)}`)
}

async function upToDate(stampFile, want, dest) {
  let stamp
  try {
    stamp = JSON.parse(await readFile(stampFile, 'utf8'))
  } catch {
    return false
  }
  if (Object.entries(want).some(([k, v]) => stamp[k] !== v) || typeof stamp.files !== 'object') return false
  if (!existsSync(dest)) return false
  const now = await hashTree(dest)
  const a = Object.entries(stamp.files).sort(([x], [y]) => x.localeCompare(y))
  const b = Object.entries(now).sort(([x], [y]) => x.localeCompare(y))
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Returns the verified archive, from the cache when its SHA-256 still matches, else from the network. */
async function download(url, expected, size, label, file) {
  if (existsSync(file)) {
    const cached = await readFile(file)
    const got = sha256(cached)
    if (got === expected) {
      log(label, `using ${rel(file)} (sha256 ${expected})`)
      return cached
    }
    log(label, `${rel(file)} does not match the pinned sha256 (got ${got}); downloading it again`)
    await rm(file, { force: true })
  }
  const buf = await fetchWithRetry(url, label, size)
  const got = sha256(buf)
  if (got !== expected) {
    throw new FetchError(
      `${label}: SHA-256 mismatch for ${url}\n  expected ${expected}${size ? ` (${String(size)} bytes)` : ''}\n` +
        `  got      ${got} (${String(buf.length)} bytes)\nNot unpacking it. If upstream replaced the asset on ` +
        `purpose, check it and update scripts/mpv-assets.json.`,
    )
  }
  log(label, `sha256 ${got} matches`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.part`, buf)
  await rename(`${file}.part`, file)
  return buf
}

async function fetchWithRetry(url, label, size, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const of = attempt > 1 ? ` (attempt ${String(attempt)} of ${String(attempts)})` : ''
      log(label, `downloading ${url}${size ? ` (${mib(size)})` : ''}${of}`)
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'cinemesh-fetch-mpv' },
        signal: AbortSignal.timeout(15 * 60_000),
      })
      if (!res.ok) {
        const e = new FetchError(`HTTP ${String(res.status)} ${res.statusText}`)
        e.retry = res.status >= 500 || res.status === 429
        throw e
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      const retry = e.retry ?? !(e instanceof FetchError)
      const why = e.cause?.message ? `${e.message} (${e.cause.message})` : e.message
      if (!retry || attempt >= attempts) throw new FetchError(`${label}: download failed: ${url}: ${why}`)
      log(label, `download failed: ${why}; retrying`)
      await sleep(2000 * attempt)
    }
  }
}

// ---- archive layout -------------------------------------------------------------------------------------------

/** Turns a verified archive into the list of entries to write, following the platform's rules in mpv-assets.json. */
function unpack(id, asset, archive) {
  const zip = readZip(archive)
  if (asset.format === 'zip') {
    // Windows: a flat zip. Take only the listed files (no mpv.pdb debug symbols, no mpv-register.bat).
    return asset.include.map((name) => {
      const entry = zip.find((e) => e.name === name)
      if (!entry) throw new FetchError(`${id}: ${name} is missing from the archive`)
      return { path: name, type: 'file', mode: 0o755, data: zipData(archive, entry) }
    })
  }
  if (asset.format === 'zip+tar.gz') {
    // macOS: GitHub's artifact zip wraps the tarball mpv's CI made of mpv.app (the tar keeps modes).
    const inner = zip.find((e) => e.name === asset.inner)
    if (!inner) throw new FetchError(`${id}: ${asset.inner} is missing from the archive`)
    const top = asset.binary.split('/')[0]
    const out = []
    for (const entry of readTar(zlib.gunzipSync(zipData(archive, inner)))) {
      if (entry.path !== top && !entry.path.startsWith(`${top}/`)) {
        throw new FetchError(`${id}: unexpected entry outside ${top}/: ${entry.path}`)
      }
      // .gitkeep placeholders in Contents/MacOS and its lib/ were signed through extended attributes that a plain
      // copy loses, which makes codesign reject the bundle; AppleDouble files only carry such metadata.
      const base = posix.basename(entry.path)
      if (base === '.gitkeep' || base === '.DS_Store' || base.startsWith('._')) continue
      out.push(entry)
    }
    return out
  }
  throw new FetchError(`${id}: unknown archive format '${String(asset.format)}'`)
}

/** Checks the executable is built for the CPU the platform id promises (guards against a mixed-up URL). */
function checkArch(id, asset, buf) {
  const fail = (what) => {
    throw new FetchError(`${id}: ${asset.binary} ${what}, expected ${String(asset.cpu)}`)
  }
  if (asset.binary.endsWith('.exe')) {
    const machines = { x64: 0x8664, arm64: 0xaa64 }
    if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) fail('is not a PE executable')
    const pe = buf.readUInt32LE(0x3c)
    if (buf.readUInt32LE(pe) !== 0x00004550) fail('is not a PE executable')
    const machine = buf.readUInt16LE(pe + 4)
    if (machine !== machines[asset.cpu]) fail(`is built for PE machine 0x${machine.toString(16)}`)
    return
  }
  const cpus = { x64: 0x01000007, arm64: 0x0100000c }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xcafebabe) {
    const n = buf.readUInt32BE(4)
    const types = Array.from({ length: n }, (_, i) => buf.readUInt32BE(8 + i * 20))
    if (!types.includes(cpus[asset.cpu])) fail('is a universal binary without that slice')
    return
  }
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0xfeedfacf) fail('is not a 64-bit Mach-O executable')
  const cpu = buf.readUInt32LE(4)
  if (cpu !== cpus[asset.cpu]) fail(`is built for Mach-O CPU type 0x${cpu.toString(16)}`)
}

// ---- writing and hashing the tree -----------------------------------------------------------------------------

/** Joins an archive path under root, refusing absolute paths, drive letters, backslashes and `..`. */
function safeJoin(root, path) {
  const parts = path.split('/').filter((s) => s !== '' && s !== '.')
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\') || parts.includes('..') || !parts.length) {
    throw new FetchError(`refusing unsafe archive path: ${path}`)
  }
  return join(root, ...parts)
}

async function writeTree(root, entries) {
  await mkdir(root, { recursive: true })
  for (const e of entries) {
    const target = safeJoin(root, e.path)
    if (e.type === 'dir') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    if (e.type === 'file') {
      await writeFile(target, e.data)
      // Owner-writable (codesign rewrites files in place) and world-readable; keep the executable bit.
      await chmod(target, e.mode & 0o111 ? 0o755 : 0o644)
    } else {
      // The pinned archives contain no links. A lexical check cannot make them safe (chained symlinks such as
      // a -> .., b -> a/.. resolve outside the tree on disk), so refuse them outright: a pin update that needs
      // links must add a realpath-based check first.
      throw new FetchError(
        `refusing ${e.type === 'symlink' ? 'symlink' : 'hard link'} in the archive: ${e.path} -> ${e.target}`,
      )
    }
  }
}

/** sha256 of every file under dir (symlinks hash their target string), keyed by POSIX path relative to dir. */
async function hashTree(dir) {
  const out = {}
  const walk = async (d) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      const key = relative(dir, p).split(/[\\/]/).join('/')
      if (ent.isDirectory()) await walk(p)
      else if (ent.isSymbolicLink()) out[key] = `symlink:${await readlink(p)}`
      else if ((await lstat(p)).isFile()) out[key] = sha256(await readFile(p))
    }
  }
  await walk(dir)
  return out
}

// ---- zip (central directory, stored/deflate, zip64) -----------------------------------------------------------

function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new FetchError('not a zip archive (no end-of-central-directory record)')
  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new FetchError('zip64 locator missing')
    const end64 = Number(buf.readBigUInt64LE(locator + 8))
    if (buf.readUInt32LE(end64) !== 0x06064b50) throw new FetchError('zip64 end record missing')
    count = Number(buf.readBigUInt64LE(end64 + 32))
    offset = Number(buf.readBigUInt64LE(end64 + 48))
  }
  const entries = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new FetchError('corrupt zip central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    let compressed = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let local = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
      const id = buf.readUInt16LE(e)
      const len = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) [size, q] = [Number(buf.readBigUInt64LE(q)), q + 8]
        if (compressed === 0xffffffff) [compressed, q] = [Number(buf.readBigUInt64LE(q)), q + 8]
        if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q))
      }
      e += 4 + len
    }
    entries.push({ name, flags, method, crc, compressed, size, local })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function zipData(buf, entry) {
  const p = entry.local
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new FetchError(`corrupt zip entry ${entry.name}`)
  if (entry.flags & 1) throw new FetchError(`encrypted zip entry ${entry.name}`)
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const raw = buf.subarray(start, start + entry.compressed)
  let data
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = zlib.inflateRawSync(raw)
  else throw new FetchError(`zip entry ${entry.name} uses unsupported method ${String(entry.method)}`)
  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc)
    throw new FetchError(`zip entry ${entry.name} is corrupt`)
  return data
}

// ---- tar (ustar, pax and GNU long names) -----------------------------------------------------------------------

function* readTar(buf) {
  const cstr = (b) => {
    const nul = b.indexOf(0)
    return b.toString('utf8', 0, nul < 0 ? b.length : nul)
  }
  const num = (b) => {
    if (b[0] & 0x80) return b.subarray(1).reduce((n, byte) => n * 256 + byte, b[0] & 0x7f) // base-256
    const s = b.toString('latin1').replaceAll('\0', ' ').trim()
    return s ? parseInt(s, 8) : 0
  }
  let pax = {}
  let longName = null
  let longLink = null
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
    if (sum !== num(h.subarray(148, 156))) throw new FetchError(`corrupt tar header at offset ${String(off)}`)
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156])
    const size = type !== 'x' && type !== 'g' && pax.size !== undefined ? Number(pax.size) : num(h.subarray(124, 136))
    const start = off + 512
    if (start + size > buf.length) throw new FetchError('truncated tar archive')
    const data = buf.subarray(start, start + size)
    off = start + Math.ceil(size / 512) * 512
    if (type === 'x') pax = parsePax(data)
    else if (type === 'L') longName = cstr(data)
    else if (type === 'K') longLink = cstr(data)
    else if (type !== 'g') {
      const posixUstar = h.toString('latin1', 257, 263) === 'ustar\0'
      const prefix = posixUstar ? cstr(h.subarray(345, 500)) : ''
      const name = cstr(h.subarray(0, 100))
      const path = (pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/\/+$/, '')
      const target = pax.linkpath ?? longLink ?? cstr(h.subarray(157, 257))
      const kind = { 0: 'file', 7: 'file', 5: 'dir', 2: 'symlink', 1: 'link' }[type]
      if (!kind) throw new FetchError(`unsupported tar entry type '${type}' for ${path}`)
      yield { path, type: kind, mode: num(h.subarray(100, 108)), data: kind === 'file' ? data : null, target }
      pax = {}
      longName = null
      longLink = null
    }
  }
}

function parsePax(data) {
  const out = {}
  for (let i = 0; i < data.length;) {
    const space = data.indexOf(0x20, i)
    const len = space < 0 ? NaN : Number(data.toString('latin1', i, space))
    if (!Number.isInteger(len) || len <= 0) break
    const record = data.toString('utf8', space + 1, i + len - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return out
}
