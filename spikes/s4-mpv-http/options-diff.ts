// For every option in the plan §4.4 argv, shows its documented signature in options.rst at v0.39.0,
// v0.40.0 and v0.41.0 and flags the ones that differ (missing, or a different value syntax).
// Docs: data/mpvdocs/options-<ver>.rst (see README for the curl command).
// Usage: npx tsx options-diff.ts
import { readFileSync } from 'node:fs'

const VERS = ['0.39.0', '0.40.0', '0.41.0']
const ARGV = `no-config script load-scripts osc input-default-bindings input-builtin-bindings input-media-keys media-controls
drag-and-drop terminal input-terminal input-builtin-dragging load-console load-osd-console load-select load-commands
load-context-menu load-positioning load-auto-profiles load-stats-overlay ytdl idle force-window keep-open resume-playback
save-position-on-quit sub-auto audio-file-auto cover-art-auto osd-bar osd-on-seek cache cache-on-disk demuxer-max-bytes
demuxer-max-back-bytes cache-secs demuxer-seekable-cache cache-pause cache-pause-initial cache-pause-wait network-timeout
stream-buffer-size hr-seek demuxer-mkv-subtitle-preroll-secs-index vo hwdec target-colorspace-hint force-media-title
autofit-larger wayland-app-id log-file gpu-api d3d11-output-csp input-ipc-client input-ipc-server`.split(/\s+/)

const dir = new URL('./data/mpvdocs/', import.meta.url).pathname
const docs = VERS.map(v => readFileSync(`${dir}options-${v}.rst`, 'utf8').split('\n'))
// The first header line ``--name...`` (or ``--[no-]name``) of each option, plus a "(default: …)" hint
// from its paragraph, which is where value domains change between versions.
function sig (lines: string[], name: string) {
  const re = new RegExp('^``--(\\[no-\\])?' + name.replace(/[-]/g, '\\-') + '(=|``|,| )')
  const i = lines.findIndex(l => re.test(l))
  if (i < 0) return null
  let def = ''
  for (let j = i + 1; j < Math.min(lines.length, i + 40) && !lines[j].startsWith('``--'); j++) {
    const m = /\(?[Dd]efault:? ?``?([^`)]*)``?\)?/.exec(lines[j])
    if (m) { def = ` (default ${m[1]})`; break }
  }
  return lines[i].replace(/``/g, '') + def
}
let differ = 0
for (const name of ARGV) {
  const s = docs.map(d => sig(d, name))
  const same = s.every(x => x === s[0])
  if (!same) differ++
  console.log(`${same ? '  ' : '≠ '}--${name.padEnd(40)} ${same ? (s[0] ?? 'MISSING in all') : s.map((x, i) => `${VERS[i]}: ${x ?? 'MISSING'}`).join(' | ')}`)
}
console.log(`\n${differ} of ${ARGV.length} options differ between ${VERS.join(', ')}`)
