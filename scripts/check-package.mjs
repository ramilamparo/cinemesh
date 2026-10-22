#!/usr/bin/env node
// check-package: verifies what electron-builder produced in release/<version>/ (plan §8 M9). CI's package job runs it
// on every OS after `electron-builder --publish never`; it also works locally after `npm run dist`.
//   all      every .node addon is unpacked (app.asar.unpacked) and none is packed in app.asar or loose elsewhere, and no
//            forbidden addon (node-datachannel, utp) ships; the fuses read back as electron-builder.yml sets them; the
//            OSC script and licence notices are in resources/
//   linux    no bundled mpv; `ldd` finds every library of the executable and of each addon; the deb and pacman packages
//            carry the invite-link .desktop entry (MimeType=x-scheme-handler/watchtogether, Exec ... %U), the icons
//            and the mpv recommendation / dependency; the rpm's weak dependency when `rpm` is installed
//   win/mac  the bundled mpv runs and reports the pinned version (scripts/mpv-assets.json)
//   mac      codesign --verify --deep --strict passes and the nested mpv.app carries an ad-hoc signature
//   --selftest  launches the packaged app (and the AppImage) with --selftest (src/core/selftest.ts, ADR 0001) and
//               requires a passing report. The report also carries the app's own mpv lookup: on Windows and macOS it
//               must have found the bundled mpv; on Linux, finding none is a warning (the runner may lack mpv).
//               Linux needs a display: run it under `xvfb-run -a` on a headless machine; set
//               APPIMAGE_EXTRACT_AND_RUN=1 where FUSE is unavailable.
// Usage: node scripts/check-package.mjs [--dir release/<version>] [--platform linux|win|mac] [--arch x64|arm64] [--selftest]
// Node built-ins only, plus ldd and tar on Linux (a .deb is unpacked in-process) and codesign on macOS.
// Exit 1 if a check fails; checks whose tool is missing (rpm) are reported as skipped, and warnings do not fail.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const MPV_VERSION = JSON.parse(readFileSync(join(import.meta.dirname, 'mpv-assets.json'), 'utf8')).version
const SCHEME = 'watchtogether'
// Native addons that must never ship: WebTorrent's WebRTC and uTP paths are stubbed out (ADR 0001).
const FORBIDDEN_ADDONS = /node[_-]datachannel|utp[_-]native|utp\.node/i
// @electron/fuses: the wire follows this sentinel as <version byte><length byte><one state byte per fuse>.
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  'wasmTrapHandlers',
]
const FUSE_STATE = { 48: 'off', 49: 'on', 114: 'removed', 144: 'inherit' }

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: join('release', PKG.version) },
    platform: { type: 'string', default: { linux: 'linux', win32: 'win', darwin: 'mac' }[process.platform] },
    arch: { type: 'string', default: process.arch },
    selftest: { type: 'boolean', default: false },
  },
})
const DIR = resolve(ROOT, args.dir)
const results = []

function report(status, name, detail = '') {
  results.push({ status, name })
  const label = { ok: 'ok  ', fail: 'FAIL', skip: 'skip', warn: 'warn' }[status]
  console.log(`[check-package] ${label} ${name}${detail ? `: ${detail}` : ''}`)
}

/** Runs one check; a thrown error is a failure, a returned { skip } a skip, { warn } a warning, anything else a pass. */
function check(name, fn) {
  try {
    const out = fn()
    if (out && typeof out === 'object' && 'skip' in out) report('skip', name, out.skip)
    else if (out && typeof out === 'object' && 'warn' in out) report('warn', name, out.warn)
    else report('ok', name, out ?? '')
  } catch (e) {
    report('fail', name, e instanceof Error ? e.message : String(e))
  }
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 2 ** 20, timeout: 120_000, ...opts })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`)
  return r
}

const have = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error === undefined
const rel = (p) => relative(ROOT, p).split(sep).join('/')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Every regular file under dir (no symlink following), as absolute paths. */
function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.isFile()) out.push(p)
  }
  return out
}

// ---- layout ------------------------------------------------------------------------------------------------------

function layout() {
  const product = PKG.productName ?? PKG.name
  if (args.platform === 'linux') {
    const app = join(DIR, args.arch === 'x64' ? 'linux-unpacked' : `linux-${args.arch}-unpacked`)
    return { app, resources: join(app, 'resources'), exe: join(app, PKG.name), fuseFile: join(app, PKG.name) }
  }
  if (args.platform === 'win') {
    const app = join(DIR, args.arch === 'x64' ? 'win-unpacked' : `win-${args.arch}-unpacked`)
    const exe = join(app, `${product}.exe`)
    return { app, resources: join(app, 'resources'), exe, fuseFile: exe }
  }
  if (args.platform === 'mac') {
    const app = join(DIR, args.arch === 'x64' ? 'mac' : `mac-${args.arch}`, `${product}.app`)
    return {
      app,
      resources: join(app, 'Contents', 'Resources'),
      exe: join(app, 'Contents', 'MacOS', product),
      fuseFile: join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    }
  }
  throw new Error(`unknown --platform ${String(args.platform)} (linux, win or mac)`)
}

// ---- asar --------------------------------------------------------------------------------------------------------

/** The JSON header of an asar archive: UInt32 4, UInt32 header pickle size, UInt32 payload size, UInt32 length, JSON. */
function readAsarHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    if (head.readUInt32LE(0) !== 4) throw new Error(`${rel(file)} is not an asar archive`)
    const json = Buffer.alloc(head.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    return JSON.parse(json.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

function asarFiles(node, prefix = '', out = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) asarFiles(entry, path, out)
    else if (!('link' in entry)) out.push({ path, unpacked: entry.unpacked === true })
  }
  return out
}

function checkAddons(L) {
  const asar = join(L.resources, 'app.asar')
  const unpackedDir = `${asar}.unpacked`
  const entries = asarFiles(readAsarHeader(asar))
  const addons = entries.filter((e) => e.path.endsWith('.node'))
  const packed = addons.filter((e) => !e.unpacked)
  if (packed.length) throw new Error(`packed inside app.asar: ${packed.map((e) => e.path).join(', ')}`)
  const missing = addons.filter((e) => !existsSync(join(unpackedDir, ...e.path.split('/'))))
  if (missing.length) throw new Error(`listed as unpacked but missing: ${missing.map((e) => e.path).join(', ')}`)
  const loose = walk(L.app).filter((f) => f.endsWith('.node') && !f.startsWith(unpackedDir + sep))
  if (loose.length) throw new Error(`outside app.asar.unpacked: ${loose.map(rel).join(', ')}`)
  const forbidden = addons.filter((e) => FORBIDDEN_ADDONS.test(e.path))
  if (forbidden.length) throw new Error(`forbidden addons ship: ${forbidden.map((e) => e.path).join(', ')}`)
  if (!addons.length) throw new Error('no .node addons at all (sodium-native and udx-native should be there)')
  // "sodium-native[linux-x64 linux-arm64]": the package and the prebuild folders (or build/) that ship
  const byPackage = new Map()
  for (const { path } of addons) {
    const m = /^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\/(?:prebuilds\/([^/]+)|([^/]+))\//.exec(path)
    const key = m?.[1] ?? path
    const where = m?.[2] ?? m?.[3] ?? '?'
    byPackage.set(key, new Set([...(byPackage.get(key) ?? []), where]))
  }
  const summary = [...byPackage].map(([name, dirs]) => `${name}[${[...dirs].join(' ')}]`).join(', ')
  return `${String(addons.length)} addons, all in app.asar.unpacked: ${summary}`
}

// ---- fuses -------------------------------------------------------------------------------------------------------

function configuredFuses() {
  const lines = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => /^electronFuses:\s*$/.test(l))
  if (start < 0) throw new Error('electron-builder.yml has no electronFuses block')
  const out = {}
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = /^\s+(\w+):\s*(true|false)\s*(#.*)?$/.exec(line)
    if (m) out[m[1]] = m[2] === 'true' ? 'on' : 'off'
  }
  return out
}

function checkFuses(L) {
  const bin = readFileSync(L.fuseFile)
  const at = bin.indexOf(FUSE_SENTINEL)
  if (at < 0) throw new Error(`no fuse wire in ${rel(L.fuseFile)}`)
  const wire = at + FUSE_SENTINEL.length
  const version = bin[wire]
  const states = [...bin.subarray(wire + 2, wire + 2 + bin[wire + 1])]
  const actual = Object.fromEntries(
    states.map((s, i) => [FUSE_NAMES[i] ?? `fuse${String(i)}`, FUSE_STATE[s] ?? String(s)]),
  )
  const wrong = Object.entries(configuredFuses()).filter(([k, v]) => actual[k] !== v)
  const table = Object.entries(actual)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  if (wrong.length)
    throw new Error(`${wrong.map(([k, v]) => `${k} is ${String(actual[k])}, want ${v}`).join('; ')} (${table})`)
  return `wire v${String(version)}: ${table}`
}

// ---- resources ---------------------------------------------------------------------------------------------------

function checkResources(L) {
  const want = [
    'mpv-scripts/wt-osc.lua',
    'licenses/THIRD-PARTY.md',
    'licenses/mpv/SOURCE-OFFER.md',
    'licenses/mpv/GPL-2.0.txt',
    'licenses/mpv/GPL-3.0.txt',
  ]
  const missing = want.filter((f) => !existsSync(join(L.resources, ...f.split('/'))))
  if (missing.length) throw new Error(`missing from resources/: ${missing.join(', ')}`)
  const stale = want.filter(
    (f) => sha256(join(L.resources, ...f.split('/'))) !== sha256(join(ROOT, 'resources', ...f.split('/'))),
  )
  if (stale.length) throw new Error(`differ from the repository's resources/: ${stale.join(', ')}`)
  return want.join(', ')
}

function checkMpv(L) {
  const dir = join(L.resources, 'mpv')
  if (args.platform === 'linux') {
    if (existsSync(dir)) throw new Error('resources/mpv exists, but Linux packages must use the system or Flatpak mpv')
    return 'none bundled (system or Flatpak mpv)'
  }
  // Windows: the app runs mpv.exe; mpv.com is its console wrapper, tried first because it always prints to a pipe.
  const bins =
    args.platform === 'win'
      ? [join(dir, 'mpv.com'), join(dir, 'mpv.exe')]
      : [join(dir, 'mpv.app', 'Contents', 'MacOS', 'mpv')]
  const main = bins.at(-1) ?? ''
  if (!existsSync(main)) throw new Error(`${rel(main)} is missing (run scripts/fetch-mpv.mjs before packaging)`)
  const tried = []
  for (const bin of bins.filter((b) => existsSync(b))) {
    const r = run(bin, ['--no-config', '--version'])
    const first = `${r.stdout}${r.stderr}`.split(/\r?\n/).find((l) => l.startsWith('mpv ')) ?? ''
    // mpv-player's CI builds come from a tagless checkout and print 'mpv v0.41.0-dev-g<hash>'; tarball builds of
    // 0.39 print 'mpv 0.39.0'. Same rule as src/core/player/mpv-version.ts.
    const version = /^mpv v?(\d+\.\d+\.\d+)(?:[-+~]\S*)?(?:\s|$)/.exec(first)?.[1]
    if (r.status === 0 && version === MPV_VERSION) return `${rel(bin)}: ${first}`
    tried.push(`${rel(bin)} --version: exit ${String(r.status)}, "${first || `${r.stdout}${r.stderr}`.trim()}"`)
  }
  throw new Error(`expected mpv ${MPV_VERSION}; ${tried.join('; ')}`)
}

// ---- Linux -------------------------------------------------------------------------------------------------------

function checkLdd(L) {
  if (!have('ldd')) return { skip: 'ldd not installed' }
  // Only what this OS/arch can load: glibc prebuilds for the package's arch, addons built in place, Electron's .so files.
  const loadable = (f) => {
    const dir = /[\\/]prebuilds[\\/]([^\\/]+)[\\/]/.exec(f)?.[1]
    return dir === undefined ? !f.endsWith('.musl.node') : dir === `linux-${args.arch}` && !f.endsWith('.musl.node')
  }
  const files = [L.exe, ...walk(L.app).filter((f) => /\.(node|so(\.\d+)*)$/.test(f) && loadable(f))]
  const problems = []
  for (const f of files) {
    const r = run('ldd', [f])
    const missing = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('not found'))
    if (missing.length) problems.push(`${rel(f)}: ${missing.map((l) => l.trim()).join('; ')}`)
  }
  if (problems.length) throw new Error(problems.join('\n  '))
  return `${String(files.length)} files, every library found`
}

/** Members of an `ar` archive (a .deb), as { name: Buffer }. */
function readAr(file) {
  const buf = readFileSync(file)
  if (buf.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error(`${rel(file)} is not an ar archive`)
  const out = {}
  for (let p = 8; p + 60 <= buf.length;) {
    const name = buf
      .toString('latin1', p, p + 16)
      .trim()
      .replace(/\/$/, '')
    const size = Number(buf.toString('latin1', p + 48, p + 58).trim())
    out[name] = buf.subarray(p + 60, p + 60 + size)
    p += 60 + size + (size % 2)
  }
  return out
}

/** A tar archive held in memory: list() its members and read() one of them, through the system tar. */
function tarball(data, label) {
  // Name the temp file after its compression so both GNU tar and bsdtar pick the right filter.
  const ext = data.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
    ? '.tar.xz'
    : data.readUInt32LE(0) === 0xfd2fb528
      ? '.tar.zst'
      : data[0] === 0x1f && data[1] === 0x8b
        ? '.tar.gz'
        : '.tar'
  const tar = (tarArgs) => {
    const tmp = mkdtempSync(join(tmpdir(), 'wt-check-'))
    try {
      const file = join(tmp, `archive${ext}`)
      writeFileSync(file, data)
      const r = run('tar', [tarArgs[0], file, ...tarArgs.slice(1)])
      if (r.status !== 0) throw new Error(`tar ${tarArgs.join(' ')} (${label}): ${r.stderr.trim()}`)
      return r.stdout
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  return {
    list: () => tar(['-tf']).split('\n').filter(Boolean),
    read: (member) => tar(['-xOf', member]),
  }
}

function checkDesktopEntry(text, where) {
  const field = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1] ?? ''
  const mime = field('MimeType')
  const exec = field('Exec')
  if (!mime.split(';').includes(`x-scheme-handler/${SCHEME}`)) throw new Error(`${where}: MimeType=${mime}`)
  if (!/ %U$/.test(exec)) throw new Error(`${where}: Exec=${exec} does not end in %U`)
  return `MimeType=${mime} Exec=${exec}`
}

function checkDeb(debs) {
  if (!debs.length) return { skip: 'no .deb in the release folder' }
  const notes = []
  for (const deb of debs) {
    const ar = readAr(deb)
    const controlName = Object.keys(ar).find((n) => n.startsWith('control.tar'))
    const dataName = Object.keys(ar).find((n) => n.startsWith('data.tar'))
    if (!controlName || !dataName) throw new Error(`${basename(deb)}: no control/data members`)
    const control = tarball(ar[controlName], `${basename(deb)} ${controlName}`)
    const controlFile = control.list().find((m) => /^(\.\/)?control$/.test(m))
    if (!controlFile) throw new Error(`${basename(deb)}: ${controlName} has no control file`)
    const recommends = /^Recommends:\s*(.*)$/m.exec(control.read(controlFile))?.[1] ?? ''
    if (!recommends.split(/,\s*/).some((d) => d.split(/\s/)[0] === 'mpv')) {
      throw new Error(`${basename(deb)}: Recommends: ${recommends || '(none)'} lacks mpv`)
    }
    const data = tarball(ar[dataName], `${basename(deb)} ${dataName}`)
    const listing = data.list()
    const desktop = listing.find((m) => /^(\.\/)?usr\/share\/applications\/.*\.desktop$/.test(m))
    if (!desktop) throw new Error(`${basename(deb)}: no .desktop entry`)
    const icons = listing.filter((m) => /usr\/share\/icons\/hicolor\/\d+x\d+\/apps\/.*\.png$/.test(m))
    if (!icons.some((m) => m.includes('/512x512/'))) throw new Error(`${basename(deb)}: no 512x512 icon`)
    const entry = checkDesktopEntry(data.read(desktop), basename(desktop))
    notes.push(
      `${basename(deb)}: Recommends: ${recommends}; ${basename(desktop)} ${entry}; ${String(icons.length)} icons`,
    )
  }
  return notes.join('\n  ')
}

function checkPacman(files) {
  if (!files.length) return { skip: 'no .pacman in the release folder' }
  const notes = []
  for (const f of files) {
    const pkg = tarball(readFileSync(f), basename(f))
    const listing = pkg.list()
    const depends = [...pkg.read('.PKGINFO').matchAll(/^depend = (.*)$/gm)].map((m) => m[1])
    if (!depends.includes('mpv')) throw new Error(`${basename(f)}: depend = mpv missing (${depends.join(', ')})`)
    const desktop = listing.find((m) => /^(\.\/)?usr\/share\/applications\/.*\.desktop$/.test(m))
    if (!desktop) throw new Error(`${basename(f)}: no .desktop entry`)
    const entry = checkDesktopEntry(pkg.read(desktop), basename(desktop))
    notes.push(`${basename(f)}: depends ${depends.join(' ')}; ${entry}`)
  }
  return notes.join('\n  ')
}

function checkRpm(files) {
  if (!files.length) return { skip: 'no .rpm in the release folder' }
  if (!have('rpm')) return { skip: `rpm is not installed, so ${files.map((f) => basename(f)).join(', ')} is unchecked` }
  const notes = []
  for (const f of files) {
    const recommends = run('rpm', ['-qp', '--recommends', f]).stdout.trim().split('\n')
    if (!recommends.some((r) => r.split(/\s/)[0] === 'mpv')) throw new Error(`${basename(f)}: Recommends lacks mpv`)
    const list = run('rpm', ['-qlp', f]).stdout.split('\n')
    if (!list.some((p) => /^\/usr\/share\/applications\/.*\.desktop$/.test(p)))
      throw new Error(`${basename(f)}: no .desktop`)
    notes.push(`${basename(f)}: Recommends ${recommends.join(', ')}`)
  }
  return notes.join('\n  ')
}

// ---- macOS -------------------------------------------------------------------------------------------------------

function checkCodesign(L) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', L.app])
  if (verify.status !== 0) throw new Error(`codesign --verify --deep --strict: ${verify.stderr.trim()}`)
  const nested = join(L.resources, 'mpv', 'mpv.app')
  const info = run('codesign', ['-dv', nested])
  if (!/Signature=adhoc/.test(info.stderr))
    throw new Error(`${rel(nested)} is not ad-hoc signed:\n${info.stderr.trim()}`)
  const plist = readFileSync(join(L.app, 'Contents', 'Info.plist'), 'utf8')
  if (!plist.includes(`<string>${SCHEME}</string>`)) throw new Error(`Info.plist does not register ${SCHEME}://`)
  if (!plist.includes('NSLocalNetworkUsageDescription'))
    throw new Error('Info.plist lacks NSLocalNetworkUsageDescription')
  return `${verify.stderr.trim().split('\n').at(-1) ?? 'valid'}; nested mpv.app Signature=adhoc; ${SCHEME}:// in Info.plist`
}

// ---- selftest ----------------------------------------------------------------------------------------------------

/**
 * The report main prints. It is found anywhere in the output, not only at a line start: with APPIMAGE_EXTRACT_AND_RUN
 * the AppImage runtime prints its extraction listing on the same stdout, and the two writers interleave.
 */
function findReport(out) {
  for (let at = out.indexOf('{"ok":'); at >= 0; at = out.indexOf('{"ok":', at + 1)) {
    for (let end = out.indexOf('}', at); end >= 0; end = out.indexOf('}', end + 1)) {
      try {
        const rep = JSON.parse(out.slice(at, end + 1))
        if (Array.isArray(rep.checks)) return rep
      } catch {
        // not complete yet: extend to the next closing brace
      }
    }
  }
  return null
}

/**
 * The app's own mpv lookup, as main ran it at startup (the report's `mpv`). Windows and macOS packages must find the
 * mpv they bundle; Linux packages use the system or Flatpak mpv, which the machine running this may not have.
 */
function selftestMpv(rep) {
  if (!rep) return { skip: 'no selftest report' }
  const m = rep.mpv
  if (!m) throw new Error('the report has no mpv lookup (src/core/selftest.ts adds it)')
  const found = `${m.status}, ${m.kind}${m.path ? ` ${m.path}` : ''}${m.version ? ` ${m.version}` : ''}`
  const tried = (m.tried ?? []).map((c) => `${c.source} ${c.path}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`)
  const why = tried.length ? `; tried ${tried.join('; ')}` : ''
  if (args.platform === 'linux') {
    return m.status === 'ok' ? found : { warn: `${found}: the app will ask its user to install mpv${why}` }
  }
  if (m.kind !== 'bundled' || m.status !== 'ok')
    throw new Error(`the bundled mpv was not the one found: ${found}${why}`)
  return found
}

function selftest(label, file) {
  let rep = null
  check(`selftest ${label}`, () => {
    if (!existsSync(file)) throw new Error(`${rel(file)} is missing`)
    const userData = mkdtempSync(join(tmpdir(), 'wt-selftest-'))
    try {
      const r = run(file, ['--selftest'], { env: { ...process.env, WT_USER_DATA: userData }, timeout: 180_000 })
      rep = findReport(r.stdout)
      const lines = rep?.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${String(c.detail).split('\n')[0]}`)
      if (r.status !== 0 || rep?.ok !== true) {
        const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-15).join('\n    ')
        throw new Error(`exit ${String(r.status ?? r.signal)}\n    ${lines ? lines.join('\n    ') : tail}`)
      }
      return `exit 0\n    ${lines.join('\n    ')}`
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
  check(`selftest ${label}: mpv lookup`, () => selftestMpv(rep))
}

// ---- main --------------------------------------------------------------------------------------------------------

const L = layout()
console.log(`[check-package] ${args.platform}-${args.arch} in ${rel(DIR)}: ${rel(L.app)}`)
if (!existsSync(L.app)) {
  report('fail', 'packaged app', `${rel(L.app)} does not exist (build it with electron-builder first)`)
} else {
  const files = existsSync(DIR) ? readdirSync(DIR).map((f) => join(DIR, f)) : []
  const ofType = (re) => files.filter((f) => re.test(f) && statSync(f).isFile())
  check('native addons', () => checkAddons(L))
  check('fuses', () => checkFuses(L))
  check('resources', () => checkResources(L))
  check('mpv', () => checkMpv(L))
  if (args.platform === 'linux') {
    check('ldd', () => checkLdd(L))
    const appImages = ofType(/\.AppImage$/)
    check('AppImage', () => {
      if (!appImages.length) return { skip: 'no .AppImage in the release folder' }
      const notExec = appImages.filter((f) => (statSync(f).mode & 0o111) === 0)
      if (notExec.length) throw new Error(`not executable: ${notExec.map(rel).join(', ')}`)
      return appImages.map((f) => `${basename(f)} (${(statSync(f).size / 2 ** 20).toFixed(0)} MiB)`).join(', ')
    })
    check('deb', () => checkDeb(ofType(/\.deb$/)))
    check('rpm', () => checkRpm(ofType(/\.rpm$/)))
    check('pacman', () => checkPacman(ofType(/\.pacman$/)))
    if (args.selftest) {
      selftest('linux-unpacked', L.exe)
      for (const f of appImages) selftest(basename(f), f)
    }
  } else {
    if (args.platform === 'mac') check('codesign', () => checkCodesign(L))
    check('installers', () => {
      const want = args.platform === 'win' ? [/Setup .*\.exe$/, /-win\.zip$/] : [/\.dmg$/, /\.zip$/]
      const found = want.map((re) => ofType(re).map((f) => basename(f)))
      if (found.some((l) => !l.length)) throw new Error(`expected ${want.join(' and ')} in ${rel(DIR)}`)
      return found.flat().join(', ')
    })
    if (args.selftest) selftest(basename(L.exe), L.exe)
  }
}

const failed = results.filter((r) => r.status === 'fail')
const count = (status) => String(results.filter((r) => r.status === status).length)
console.log(
  `[check-package] ${failed.length ? `FAILED: ${failed.map((r) => r.name).join(', ')}` : 'all checks passed'} ` +
    `(${count('ok')} ok, ${count('warn')} warnings, ${count('skip')} skipped)`,
)
process.exitCode = failed.length ? 1 : 0
