// Classifies the server log of one run against the golden ranges.
import type { ReqLog } from './server.js'
import { merge, roundOut, type Range, type Golden } from './ranges.js'

export function bytesOutside (from: number, to: number, allowed: Range[]) {
  let inside = 0
  for (const [s, e] of allowed) inside += Math.max(0, Math.min(to, e) - Math.max(from, s))
  return (to - from) - inside
}
export const inRanges = (b: number, rs: Range[]) => rs.some(([s, e]) => b >= s && b < e)

export interface PhaseReport {
  phase: string
  tStart: number
  tEnd: number
  restartMs: number | null
  requests: { id: number, conn: number, connReq: number, start: number, startClass: string, sent: number, sentInPhase: number, closedBy: string | null, continuation: boolean }[]
  bytesInPhase: number
  outsideExact: number
  outsidePieces: number
  outsideExactNotReadahead: number
  maxParallel: number
  maxOverlapMs: number // longest time two requests for this file were open together
  newConnections: number
  reconnects: number
  blocked: number[]
}

export type Variant = 'plan' | 'fixed'
export const openOf = (g: Golden, v: Variant) => v === 'plan' ? g.openCritical : g.openCriticalFixed

export function classify (g: Golden, b: number, readyKeys: string[], v: Variant = 'plan') {
  if (inRanges(b, openOf(g, v))) return 'open'
  if (inRanges(b, g.seekCritical)) return 'seek'
  for (const k of readyKeys) if (inRanges(b, [g.readyRange[k][v]])) return `ready(${Number(k) / 1000}s)`
  if (inRanges(b, roundOut([...openOf(g, v), ...g.seekCritical, ...readyKeys.map(k => g.readyRange[k][v])], g.pieceLength, g.size))) return 'same-piece'
  return 'OUTSIDE'
}

export function phaseReport (g: Golden, log: ReqLog[], phase: string, tStart: number, tEnd: number, readyKeys: string[], restartMs: number | null, v: Variant = 'plan'): PhaseReport {
  const file = g.file
  const reqs = log.filter(r => r.file === file && r.method === 'GET')
  const allowed = merge([...openOf(g, v), ...g.seekCritical, ...readyKeys.map(k => g.readyRange[k][v])])
  const allowedP = roundOut(allowed, g.pieceLength, g.size)
  let bytes = 0; let outE = 0; let outP = 0; let outNR = 0
  const touched = reqs.filter(r => r.tOpen < tEnd && (r.tClose ?? Infinity) >= tStart)
  for (const r of touched) {
    // Readahead = bytes of a request that started inside the allowed set and ran on contiguously.
    const startedInside = inRanges(r.start, allowed)
    for (const [t, a, b] of r.slices) {
      if (t < tStart || t >= tEnd) continue
      bytes += b - a
      const o = bytesOutside(a, b, allowed)
      outE += o
      outP += bytesOutside(a, b, allowedP)
      if (!startedInside) outNR += o
    }
  }
  // Max parallel open requests for this file during the phase.
  const pts: [number, number][] = []
  for (const r of touched) { pts.push([Math.max(r.tOpen, tStart), 1]); pts.push([Math.min(r.tClose ?? tEnd, tEnd), -1]) }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0; let maxPar = 0
  for (const [, d] of pts) { cur += d; maxPar = Math.max(maxPar, cur) }
  let maxOverlapMs = 0
  for (const a of touched) for (const b of touched) {
    if (a.id >= b.id) continue
    const ov = Math.min(a.tClose ?? tEnd, b.tClose ?? tEnd, tEnd) - Math.max(a.tOpen, b.tOpen, tStart)
    if (ov > maxOverlapMs) maxOverlapMs = ov
  }
  const opened = reqs.filter(r => r.tOpen >= tStart && r.tOpen < tEnd)
  const requests = opened.map(r => {
    const prev = reqs.filter(p => p.id < r.id && p.tClose !== null && p.tClose <= r.tOpen + 1)
    const continuation = prev.some(p => p.start + p.sent === r.start && p.closedBy === 'client')
    let sentInPhase = 0
    for (const [t, a, b] of r.slices) if (t >= tStart && t < tEnd) sentInPhase += b - a
    return { id: r.id, conn: r.conn, connReq: r.connReq, start: r.start, startClass: classify(g, r.start, readyKeys, v), sent: r.sent, sentInPhase, closedBy: r.closedBy, continuation }
  })
  return {
    phase, tStart, tEnd, restartMs, requests, bytesInPhase: bytes, outsideExact: outE, outsidePieces: outP, outsideExactNotReadahead: outNR,
    maxParallel: maxPar, maxOverlapMs: Math.round(maxOverlapMs * 10) / 10, newConnections: opened.filter(r => r.connReq === 1).length, reconnects: requests.filter(r => r.continuation).length,
    blocked: touched.flatMap(r => r.blocked.filter(b => b.t >= tStart && b.t < tEnd).map(b => b.at)),
  }
}
