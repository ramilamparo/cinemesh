#!/usr/bin/env node
// changelog: keeps CHANGELOG.md in step with package.json's version (docs/RELEASING.md "Versioning").
//   release  turns the "## Unreleased" section into "## <version> - <date>" and starts a new, empty Unreleased
//            section above it. package.json's `version` lifecycle script runs it during `npm version`, after the bump
//            and before npm commits and tags, so the changelog lands in the release commit.
//   notes <version>  prints that version's section (without its heading) for the GitHub release; exit 1 if the
//            changelog has no section for it, or the section is empty.
// Usage: node scripts/changelog.mjs release | notes <version>
import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const FILE = join(ROOT, 'CHANGELOG.md')
const UNRELEASED = '## Unreleased'
const EMPTY = `${UNRELEASED}\n\nNothing yet.\n`

/** The "## " sections of the changelog: heading line, and the body up to the next section. */
function sections(text) {
  const out = []
  const re = /^## .*$/gm
  let m
  while ((m = re.exec(text))) out.push({ heading: m[0], start: m.index, bodyStart: m.index + m[0].length })
  return out.map((s, i) => ({ ...s, end: out[i + 1]?.start ?? text.length }))
}

function fail(message) {
  console.error(`changelog: ${message}`)
  process.exit(1)
}

const [command, arg] = process.argv.slice(2)
const text = readFileSync(FILE, 'utf8')

if (command === 'release') {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const all = sections(text)
  if (all.some((s) => s.heading.startsWith(`## ${version} `))) fail(`CHANGELOG.md already has a ${version} section`)
  const open = all.find((s) => s.heading === UNRELEASED)
  if (!open) fail(`CHANGELOG.md has no "${UNRELEASED}" section`)
  const body = text.slice(open.bodyStart, open.end).trim()
  if (!body || body === 'Nothing yet.') fail(`"${UNRELEASED}" is empty: write the release's changes there first`)
  const date = new Date().toISOString().slice(0, 10)
  const next = `${text.slice(0, open.start)}${EMPTY}\n## ${version} - ${date}\n\n${body}\n\n${text.slice(open.end)}`
  writeFileSync(FILE, `${next.trimEnd()}\n`)
  console.log(`changelog: "${UNRELEASED}" is now ${version} (${date})`)
} else if (command === 'notes' && arg) {
  const version = arg.replace(/^v/, '')
  const s = sections(text).find((x) => x.heading.startsWith(`## ${version} `) || x.heading === `## ${version}`)
  if (!s) fail(`CHANGELOG.md has no section for ${version}`)
  const body = text.slice(s.bodyStart, s.end).trim()
  if (!body) fail(`the ${version} section of CHANGELOG.md is empty`)
  console.log(body)
} else {
  fail('usage: node scripts/changelog.mjs release | notes <version>')
}
