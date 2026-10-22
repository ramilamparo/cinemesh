// --input-ipc-client=fd://3 with Node's stdio[3] = 'pipe' (a socketpair on Unix).
// Records the fd type mpv sees, client_name, a round trip, and whether mpv quits when we close the fd.
import { spawn } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import type { Socket } from 'node:net'
import { once } from 'node:events'

const t0 = performance.now()
const p = spawn('mpv', ['--no-config', '--idle=yes', '--vo=null', '--ao=null', '--terminal=no', '--input-ipc-client=fd://3'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
const sock = p.stdio[3] as Socket
let fdType = '?'
await new Promise(r => setTimeout(r, 200))
try { fdType = readlinkSync(`/proc/${p.pid}/fd/3`) } catch (e) { fdType = String(e) }
const replies = new Map<number, (m: any) => void>()
let buf = ''
sock.on('data', d => {
  buf += d.toString(); let i
  while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.request_id) replies.get(m.request_id)?.(m) }
})
const cmd = (id: number, command: unknown[]) => new Promise<any>(resolve => { replies.set(id, resolve); sock.write(JSON.stringify({ command, request_id: id }) + '\n') })
const name = await cmd(1, ['client_name'])
const ver = await cmd(2, ['get_property', 'mpv-version'])
const rtts: number[] = []
for (let i = 0; i < 200; i++) { const t = performance.now(); await cmd(100 + i, ['get_property', 'idle-active']); rtts.push(performance.now() - t) }
rtts.sort((a, b) => a - b)
const tClose = performance.now()
const exited = once(p, 'exit')
sock.end(); sock.destroy()
const killer = setTimeout(() => p.kill('SIGKILL'), 5000)
const [code, sig] = await exited
clearTimeout(killer)
console.log(JSON.stringify({
  fdTypeInMpv: fdType, clientName: name.data, mpvVersion: ver.data,
  rttMs: { p50: +rtts[100].toFixed(3), p99: +rtts[198].toFixed(3) },
  exitAfterCloseMs: +(performance.now() - tClose).toFixed(1), exitCode: code, signal: sig, startupToFirstReplyMs: +(tClose - t0).toFixed(0),
}))
