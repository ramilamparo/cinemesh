#!/usr/bin/env node
// third-party-licenses: writes resources/licenses/THIRD-PARTY.md, the notices for the npm packages that ship inside
// the app. Packaged with every build as <resources>/licenses/THIRD-PARTY.md (electron-builder.yml extraResources).
//
// Two sets of packages ship:
// - the production dependency tree: package.json `dependencies`, followed recursively through each package's
//   dependencies plus the optional and peer dependencies that are installed. electron-builder copies the same set
//   into app.asar (it asks `npm list --omit dev`).
// - devDependencies that electron-vite bundles into out/: the packages that non-test sources under src/ import (React,
//   react-dom and zustand in the renderer), with their own dependency trees.
// Packages are found the way Node resolves them (node_modules folders up to the project root) by reading their
// package.json; licence texts are each package's LICENSE / LICENCE / COPYING / NOTICE files, which electron-builder
// partly drops (it excludes *.md under node_modules), so this file carries them. Run after `npm ci` and whenever
// dependencies change.
// Usage: node scripts/third-party-licenses.mjs [--check]   (--check: exit 1 if the file is out of date)
import console from 'node:console'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'resources', 'licenses', 'THIRD-PARTY.md')
const check = process.argv.includes('--check')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

const rootPkg = readJson(join(ROOT, 'package.json'))
const packages = new Map() // "name@version" -> info
const warnings = []

/** Node's lookup: <dir>/node_modules/<name>, then each parent directory, without leaving the project. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dir === ROOT || dirname(dir) === dir || !dir.startsWith(ROOT)) return null
  }
}

function visit(dir, how, seenDirs) {
  if (seenDirs.has(dir)) return
  seenDirs.add(dir)
  const pkg = readJson(join(dir, 'package.json'))
  const key = `${pkg.name}@${pkg.version}`
  const info = packages.get(key) ?? describe(pkg, dir)
  info.how.add(how)
  packages.set(key, info)
  const optional = new Set([
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.entries(pkg.peerDependenciesMeta ?? {})
      .filter(([, m]) => m.optional)
      .map(([n]) => n),
  ])
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  for (const name of deps) {
    if (name.startsWith('@types/')) continue // type declarations only: no code ships
    const found = resolvePackage(name, dir)
    if (found) visit(found, how, seenDirs)
    else if (!optional.has(name) && !(pkg.peerDependencies && name in pkg.peerDependencies)) {
      warnings.push(`${key}: dependency ${name} is not installed`)
    }
  }
}

function describe(pkg, dir) {
  let license = pkg.license
  if (license && typeof license === 'object') license = license.type
  if (!license && Array.isArray(pkg.licenses)) license = pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  if (!license) {
    license = 'UNKNOWN'
    warnings.push(`${pkg.name}@${pkg.version}: no licence in package.json`)
  }
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|copyright)([-_.].*)?$/i.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim() }))
  return { name: pkg.name, version: pkg.version, license, source: repoUrl(pkg), files, how: new Set() }
}

function repoUrl(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!r) return pkg.homepage ?? null
  const hosts = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }
  const short = /^(github|gitlab|bitbucket):(.+)$/.exec(r)
  if (short) return `https://${hosts[short[1]]}/${short[2]}`
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`
  return r
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
}

/** Bare imports in non-test sources under src/ (electron-vite bundles devDependencies among them into out/). */
function importedPackages() {
  const names = new Set()
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) {
        if (!['test', 'testing', '__snapshots__'].includes(ent.name)) walk(p)
      } else if (/\.(ts|tsx|mts|js|mjs)$/.test(ent.name) && !/\.(test|spec)\.\w+$/.test(ent.name)) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(
          /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm,
        )) {
          const spec = m[1] ?? m[2] ?? m[3]
          if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
          names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
        }
      }
    }
  }
  walk(join(ROOT, 'src'))
  return names
}

const shipped = new Set()
for (const name of [...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.optionalDependencies ?? {})]) {
  const dir = resolvePackage(name, ROOT)
  if (dir) visit(dir, 'node_modules', shipped)
  else warnings.push(`dependency ${name} is not installed (run npm ci)`)
}
const bundled = new Set()
for (const name of importedPackages()) {
  if (!(name in (rootPkg.devDependencies ?? {})) || name === 'electron') continue
  const dir = resolvePackage(name, ROOT)
  if (dir) visit(dir, 'bundled', bundled)
}

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const byLicense = new Map()
for (const p of list) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1)
const fence = (text) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}
const esc = (s) => s.replaceAll('|', '\\|')

const lines = [
  '# Third-party software in Cinemesh',
  '',
  '<!-- Generated by scripts/third-party-licenses.mjs from node_modules. Do not edit by hand. -->',
  '',
  'Cinemesh is MIT-licensed. It is built on the open-source software below.',
  '',
  '- **Electron** (MIT) and **Chromium** (BSD-3-Clause and others): their notices ship next to the executable as',
  '  `LICENSE.electron.txt` and `LICENSES.chromium.html` (inside the app bundle on macOS).',
  '- **mpv** 0.41.0, in the Windows and macOS packages only: a separate program under the GPL. See',
  '  `mpv/SOURCE-OFFER.md` and the licence texts in `mpv/`.',
  `- **npm packages**: the ${String(list.length)} packages listed here, with their licence texts.`,
  '  "node_modules" means the package is copied into the app (`resources/app.asar`); "bundled" means its code is',
  "  compiled into the app's JavaScript (`out/`).",
  '',
  `Licences: ${[...byLicense]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `${l} (${String(n)})`)
    .join(', ')}.`,
  '',
  '## Packages',
  '',
  '| Package | Version | Licence | Ships as | Source |',
  '| --- | --- | --- | --- | --- |',
  ...list.map(
    (p) =>
      `| ${esc(p.name)} | ${esc(p.version)} | ${esc(p.license)} | ${[...p.how].sort().join(', ')} | ${p.source ? `<${p.source}>` : ''} |`,
  ),
  '',
  '## Licence texts',
  '',
  'Packages whose licence files are identical share one entry.',
  '',
]
const texts = new Map() // text -> package ids
const noText = []
for (const p of list) {
  if (!p.files.length) {
    noText.push(p)
    continue
  }
  const text = p.files.map((f) => (p.files.length > 1 ? `${f.file}:\n\n${f.text}` : f.text)).join('\n\n')
  texts.set(text, [...(texts.get(text) ?? []), `${p.name} ${p.version}`])
}
for (const [text, ids] of texts) {
  const f = fence(text)
  lines.push(`### ${ids.join(', ')}`, '', f, text, f, '')
}
if (noText.length) {
  lines.push(
    '### Packages without a licence file',
    '',
    'These packages state their licence only in package.json:',
    '',
    ...noText.map((p) => `- ${p.name} ${p.version}: ${p.license}${p.source ? ` (${p.source})` : ''}`),
    '',
  )
}
const output = `${lines.join('\n').trimEnd()}\n`

for (const w of warnings) console.warn(`[third-party-licenses] warning: ${w}`)
const rel = relative(ROOT, OUT).split(sep).join('/')
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== output) {
    console.error(`[third-party-licenses] ${rel} is out of date: run node scripts/third-party-licenses.mjs`)
    process.exitCode = 1
  } else console.log(`[third-party-licenses] ${rel} is up to date (${String(list.length)} packages)`)
} else {
  await writeFile(OUT, output)
  console.log(
    `[third-party-licenses] wrote ${rel}: ${String(list.length)} packages, ${String(texts.size)} licence texts`,
  )
}
