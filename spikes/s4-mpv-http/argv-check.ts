// Runs the plan §4.4 argv (built by mpv-args.ts for the installed mpv) and checks every option parses.
// A: argv + --idle=no, no file (parse only; mpv prints usage and exits).
// B: argv + --idle=no --frames=0 + a local fixture (full init: script, VO, demuxer). A window may flash.
// Also prints the argv that would be used for 0.39 and 0.40 (not executable here: no binaries).
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { mpvArgs, parseMpvVersion, type MpvVersion } from './mpv-args.js'

const here = new URL('.', import.meta.url).pathname
const run = `${here}data/run`; mkdirSync(run, { recursive: true })
// resDir layout: <res>/mpv-scripts/wt-osc.lua → point at a temp dir holding the stub
mkdirSync(`${run}/res/mpv-scripts`, { recursive: true })
execFileSync('cp', [`${here}stub-wt-osc.lua`, `${run}/res/mpv-scripts/wt-osc.lua`])
const ver = parseMpvVersion(execFileSync('mpv', ['--version']).toString())!
const base = (v: MpvVersion, log: string) => mpvArgs({ version: v, os: 'linux', wayland: !!process.env.WAYLAND_DISPLAY, resDir: `${run}/res`, logFile: log, mediaTitle: 'S4 argv check', ipc: `--input-ipc-server=${run}/argv.sock` })
const bad = /option not found|could not be parsed|failed\.|unknown option|Fatal error/i
for (const [name, extra] of [['A parse-only', ['--idle=no']], ['B full init', ['--idle=no', '--frames=0', `${here}data/mkv-cues.mkv`]]] as const) {
  const log = `${run}/argv-${name[0]}.log`
  const args = [...base(ver, log), ...extra]
  const r = spawnSync('mpv', args, { timeout: 30000, encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  let logText = ''; try { logText = readFileSync(log, 'utf8') } catch {}
  const errs = logText.split('\n').filter(l => /\]\[e\]|\]\[f\]/.test(l))
  console.log(`${name}: exit=${r.status} signal=${r.signal} parseErrors=${out.split('\n').filter(l => bad.test(l)).length} logErrors=${errs.length}`)
  for (const e of errs.slice(0, 10)) console.log('   ', e)
  const stub = logText.split('\n').find(l => l.includes('wt-osc stub loaded'))
  if (stub) console.log('   ', stub.trim())
}
console.log(`\nargv for mpv ${ver.major}.${ver.minor}.${ver.patch}:\n${base(ver, '<logs>/mpv.log').join(' ')}`)
for (const minor of [39, 40]) {
  const a = base({ major: 0, minor, patch: 0 }, '<logs>/mpv.log')
  const b = base(ver, '<logs>/mpv.log')
  console.log(`\n0.${minor} differs from ${ver.major}.${ver.minor}: -[${b.filter(x => !a.includes(x)).join(' ')}] +[${a.filter(x => !b.includes(x)).join(' ')}]`)
}
