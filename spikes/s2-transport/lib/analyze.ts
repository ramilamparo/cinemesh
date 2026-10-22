// Turns the members' raw reports into the S2 numbers.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number
}
export const median = (v: number[]): number | null => pct(v, 50)
const MB = 1e6
const round = (x: number | null, d = 1): number | null => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d)

export function analyze(reports: any[], opts: { idleMs: number; fileLength: number }): Record<string, unknown> {
  const host = reports.find((r) => r.role === 'host')
  const viewers = reports.filter((r) => r.role === 'viewer')
  const goAt: number = host.goAt
  const endAt: number = Math.max(...reports.map((r) => r.endAt))

  // throughput
  const perViewer = viewers.map((v) => {
    const first = v.samples.find((s: any) => s.downloaded > 0)
    const until = v.doneAt || v.endAt
    const secs = first ? (until - first.at) / 1000 : 0
    const fromHost = v.links.find((l: any) => l.isHost)
    return {
      name: v.name,
      done: !!v.doneAt,
      seconds: round(secs),
      MBps: first ? round(v.downloaded / MB / secs) : 0,
      fromHostMB: round((fromHost?.down ?? 0) / MB),
      fromViewersMB: round(v.links.filter((l: any) => !l.isHost).reduce((a: number, l: any) => a + l.down, 0) / MB),
      window: { from: first?.at ?? goAt, to: until },
    }
  })
  const lastDone = Math.max(...perViewer.map((v) => v.window.to))
  const hostSecs = (lastDone - goAt) / 1000
  const throughput = {
    perViewer: perViewer.map(({ window: _w, ...v }) => v),
    viewerMedianMBps: median(perViewer.map((v) => v.MBps as number)),
    viewerMinMBps: Math.min(...perViewer.map((v) => v.MBps as number)),
    aggregateViewerMBps: round(viewers.reduce((a, v) => a + v.downloaded, 0) / MB / hostSecs),
    hostUploadMBps: round(host.uploaded / MB / hostSecs),
    hostUploadedMB: round(host.uploaded / MB),
    dupFactorNoStriping: round(host.uploaded / opts.fileLength, 2),
  }

  // ctrl and datagram latency: idle = the idle phase before 'go'; saturated = while that viewer downloads
  const windows = new Map(perViewer.map((v) => [v.name, { from: Math.max(goAt + 1000, v.window.from + 500), to: v.window.to - 500 }]))
  const idleFrom = goAt - opts.idleMs + 1000
  const ctrlIdle: number[] = []
  const ctrlExtra: number[] = []
  const ctrlSat: number[] = []
  for (const name of windows.keys()) {
    const w = windows.get(name)!
    const rtts = host.ctrlRtts.filter((r: any) => r.link === name)
    const idle = rtts.filter((r: any) => r.at >= idleFrom && r.at < goAt).map((r: any) => r.rtt)
    const base = median(idle) ?? 0
    ctrlIdle.push(...idle)
    for (const r of rtts) {
      if (r.at < w.from || r.at > w.to) continue
      ctrlSat.push(r.rtt)
      ctrlExtra.push(r.rtt - base)
    }
  }
  const dgram = (phase: 'idle' | 'sat') => {
    const rtt = new Map(host.dgramRtts.map((d: any) => [d.k, d.rtt]))
    let sent = 0
    let lost = 0
    const rtts: number[] = []
    for (const s of host.dgramSent) {
      const w = windows.get(s.link)
      if (!w) continue
      const inWin = phase === 'idle' ? s.at >= idleFrom && s.at < goAt : s.at >= w.from && s.at <= w.to
      if (!inWin || s.at > endAt - 1000) continue
      sent++
      const r = rtt.get(`${s.link}:${s.seq}`) as number | undefined
      if (r === undefined) lost++
      else rtts.push(r)
    }
    return { sent, lossPct: sent ? round((lost / sent) * 100, 2) : null, p50: round(median(rtts), 2), p95: round(pct(rtts, 95), 2), max: round(rtts.length ? Math.max(...rtts) : null, 1) }
  }
  const latency = {
    ctrl: {
      idleP50: round(median(ctrlIdle), 2),
      idleP95: round(pct(ctrlIdle, 95), 2),
      satP50: round(median(ctrlSat), 2),
      satP95: round(pct(ctrlSat, 95), 2),
      extraP50: round(median(ctrlExtra), 2),
      extraP95: round(pct(ctrlExtra, 95), 2),
      extraMax: round(ctrlExtra.length ? Math.max(...ctrlExtra) : null, 1),
      samples: ctrlExtra.length,
    },
    dgramIdle: dgram('idle'),
    dgramSat: dgram('sat'),
  }

  // memory and event loop, per process (in one-process mode all members share one)
  const procs = new Map<number, any[]>()
  for (const r of reports) procs.set(r.pid, [...(procs.get(r.pid) ?? []), r])
  const perProcess = [...procs.values()].map((rs) => {
    const r = rs[0]
    const before = r.samples.filter((s: any) => s.at < goAt)
    const during = r.samples.filter((s: any) => s.at >= goAt)
    const base = before.length ? before[before.length - 1] : r.samples[0]
    const peak = (k: string) => Math.max(...during.map((s: any) => s[k]))
    return {
      members: rs.map((x) => x.name).join('+'),
      rssBaseMB: round(base.rss / MB),
      rssPeakMB: round(peak('rss') / MB),
      rssGrowthMB: round((peak('rss') - base.rss) / MB),
      arrayBuffersPeakMB: round(peak('arrayBuffers') / MB),
      heapPeakMB: round(peak('heapUsed') / MB),
      cpuPct: round(r.cpuPct),
      eluPct: round(r.eluPct),
      eldIdleP99: round(r.eldIdle?.p99 ?? null, 2),
      eldP50: round(Math.max(...rs.map((x) => x.eldBusy?.p50 ?? 0)), 2),
      eldP99: round(Math.max(...rs.map((x) => x.eldBusy?.p99 ?? 0)), 2),
      eldMax: round(Math.max(...rs.map((x) => x.eldBusy?.max ?? 0)), 1),
    }
  })

  // lane setup and re-attach
  const attaches = reports.flatMap((r) => r.links.flatMap((l: any) => l.attaches.filter((a: any) => a.reason === 'go')))
  const wireMs = attaches.map((a: any) => a.wireMs).filter((x: any) => x !== null)
  const chMs = attaches.map((a: any) => a.chOpenedMs).filter((x: any) => x !== null)
  const connMs = reports.flatMap((r) => r.connEvents.map((e: any) => e.openedMs))
  const handshake = {
    lanes: attaches.length,
    lanesWithWire: wireMs.length,
    connOpenedMsMax: round(connMs.length ? Math.max(...connMs) : null, 2),
    chOpenedMsP50: round(median(chMs), 2),
    chOpenedMsMax: round(chMs.length ? Math.max(...chMs) : null, 2),
    wireMsP50: round(median(wireMs), 2),
    wireMsMax: round(wireMs.length ? Math.max(...wireMs) : null, 2),
  }
  const re = viewers
    .flatMap((v) => v.links.filter((l: any) => l.isHost).flatMap((l: any) => l.attaches))
    .find((a: any) => a.sinceDestroy)
  const reattach = re ? { ...re.sinceDestroy, attaches: viewers.flatMap((v) => v.links.filter((l: any) => l.isHost).map((l: any) => l.attaches.length)) } : null

  // host-side UDX state per viewer link during that viewer's saturated window
  const udxRows = (host.udxSamples ?? []).filter((u: any) => {
    const w = windows.get(u.link)
    return w && u.at >= w.from && u.at <= w.to
  })
  const perLink = [...windows.keys()].map((name) => udxRows.filter((u: any) => u.link === name))
  const udx = udxRows.length
    ? {
        srttMsP50: median(udxRows.map((u: any) => u.rtt)),
        srttMsP95: pct(udxRows.map((u: any) => u.rtt), 95),
        inflightKBP50: round(median(udxRows.map((u: any) => u.inflight / 1024))),
        inflightKBMax: round(Math.max(...udxRows.map((u: any) => u.inflight / 1024))),
        cwndP50: median(udxRows.map((u: any) => u.cwnd)),
        retransmits: perLink.reduce((a, rs) => a + (rs.length ? rs[rs.length - 1].retransmits - rs[0].retransmits : 0), 0),
        fastRecoveries: perLink.reduce((a, rs) => a + (rs.length ? rs[rs.length - 1].fastRecoveries - rs[0].fastRecoveries : 0), 0),
        rtoCountMax: Math.max(...udxRows.map((u: any) => u.rtoCount)),
      }
    : null

  const paths = reports.flatMap((r) => r.links.map((l: any) => `${r.name}->${l.remote}:${l.path}`))
  const reattaches = viewers
    .flatMap((v) => v.links.filter((l: any) => l.isHost).flatMap((l: any) => l.attaches))
    .filter((a: any) => a.sinceDestroy)
    .map((a: any) => a.sinceDestroy.firstData)
  return { throughput, latency, perProcess, handshake, reattach, reattachFirstDataMs: reattaches, udx, live: Object.fromEntries(reports.map((r) => [r.name, r.live])), paths, storeStats: host.store }
}
