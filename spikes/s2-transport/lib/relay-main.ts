// Child process entry for the blind relay, so relayed bytes do not share the orchestrator's event loop.
import { startRelay } from './relay.js'

process.once('message', async (msg: { bootstrap: { host: string; port: number }[] }) => {
  const relay = await startRelay(msg.bootstrap)
  let t0 = performance.now()
  let cpu0 = process.cpuUsage()
  let rssPeak = 0
  const rssTimer = setInterval(() => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)), 250)
  process.send?.({ t: 'relay', publicKey: relay.publicKey.toString('hex'), ports: relay.ports })
  process.on('message', async (m: { t: string }) => {
    if (m.t === 'go') {
      t0 = performance.now()
      cpu0 = process.cpuUsage()
      return
    }
    if (m.t !== 'stop') return
    clearInterval(rssTimer)
    const cpu = process.cpuUsage(cpu0)
    const cpuPct = ((cpu.user + cpu.system) / 1000 / (performance.now() - t0)) * 100 // since 'go'
    process.send?.({ t: 'relay-stats', stats: { ...(relay.stats() as object), cpuPctTransfer: Math.round(cpuPct), rssPeakMB: Math.round(rssPeak / 1e6) } })
    await relay.close()
    setTimeout(() => process.exit(0), 100)
  })
})
process.on('disconnect', () => process.exit(0))
