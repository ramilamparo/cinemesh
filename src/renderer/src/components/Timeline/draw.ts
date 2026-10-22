import type { Span } from '../../../../shared/ipc/core'
import type { Palette } from '../../../../shared/theme-tokens'
import { formatTime } from '../../lib/format'

// Pure canvas renderer for the room timeline (plan §4.6). Everything is drawn in CSS pixels after a
// DPR transform, so callers pass the element's CSS size and devicePixelRatio.

export const TIMELINE_HEIGHT = 44

/** Vertical layout in CSS px. */
export const LAYOUT = {
  markerTop: 0,
  markerHeight: 7,
  barTop: 9,
  barHeight: 24,
  bufferedTop: 35,
  bufferedHeight: 5,
} as const

export type TimelineCtx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'clearRect'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'stroke'
  | 'rect'
  | 'clip'
  | 'fillText'
  | 'measureText'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'globalAlpha'
  | 'font'
  | 'textBaseline'
  | 'textAlign'
>

export interface TimelineSize {
  /** CSS pixels */
  width: number
  height: number
  dpr: number
}

export interface TimelineMarker {
  id: string
  name: string
  posS: number
  color: string
}

export type SpanState = 'downloaded' | 'downloading' | 'missing'

export interface TimelineDrawState {
  durationS: number | null
  /** viewer: done; host: groupDone (every viewer has it) */
  downloaded: Span[]
  downloading: Span[]
  buffered: Span[]
  posS: number | null
  markers: TimelineMarker[]
  /** pointer position in CSS px with its prepared label */
  hover: { x: number; label: string } | null
}

export type TimelineTokens = Pick<
  Palette,
  'tl-missing' | 'tl-downloading' | 'tl-downloaded' | 'tl-buffered' | 'playhead' | 'bg' | 'text' | 'surface' | 'border'
>

const STRIPE_SPACING = 7
const STRIPE_WIDTH = 2.5

export function drawTimeline(
  ctx: TimelineCtx,
  size: TimelineSize,
  state: TimelineDrawState,
  tokens: TimelineTokens,
): void {
  const { width, height, dpr } = size
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (width <= 0) return

  const { barTop, barHeight } = LAYOUT
  // 1. missing
  ctx.fillStyle = tokens['tl-missing']
  ctx.fillRect(0, barTop, width, barHeight)

  const duration = state.durationS
  if (duration === null || !(duration > 0)) return
  const xOf = (t: number): number => (Math.min(Math.max(t, 0), duration) / duration) * width
  const rectOf = (span: Span): [number, number] | null => {
    const x0 = xOf(span[0])
    const x1 = xOf(span[1])
    if (x1 <= x0 && span[1] <= span[0]) return null
    return [x0, Math.max(1, x1 - x0)]
  }

  // 2. downloaded
  ctx.fillStyle = tokens['tl-downloaded']
  for (const span of state.downloaded) {
    const r = rectOf(span)
    if (r) ctx.fillRect(r[0], barTop, r[1], barHeight)
  }

  // 3. downloading, with 45° stripes so the state does not rely on colour alone
  for (const span of state.downloading) {
    const r = rectOf(span)
    if (!r) continue
    ctx.fillStyle = tokens['tl-downloading']
    ctx.fillRect(r[0], barTop, r[1], barHeight)
    ctx.save()
    ctx.beginPath()
    ctx.rect(r[0], barTop, r[1], barHeight)
    ctx.clip()
    ctx.strokeStyle = tokens.bg
    ctx.globalAlpha = 0.5
    ctx.lineWidth = STRIPE_WIDTH
    ctx.beginPath()
    const first = Math.floor((r[0] - barHeight) / STRIPE_SPACING) * STRIPE_SPACING
    for (let x = first; x < r[0] + r[1]; x += STRIPE_SPACING) {
      ctx.moveTo(x, barTop + barHeight)
      ctx.lineTo(x + barHeight, barTop)
    }
    ctx.stroke()
    ctx.restore()
  }

  // 4. mpv's buffered strip
  ctx.fillStyle = tokens['tl-buffered']
  for (const span of state.buffered) {
    const r = rectOf(span)
    if (r) ctx.fillRect(r[0], LAYOUT.bufferedTop, r[1], LAYOUT.bufferedHeight)
  }

  // 5. peer markers: downward triangles above the bar
  for (const m of state.markers) {
    const x = xOf(m.posS)
    ctx.fillStyle = m.color
    ctx.beginPath()
    ctx.moveTo(x - 4.5, LAYOUT.markerTop)
    ctx.lineTo(x + 4.5, LAYOUT.markerTop)
    ctx.lineTo(x, LAYOUT.markerTop + LAYOUT.markerHeight)
    ctx.closePath()
    ctx.fill()
  }

  // 6. playhead
  if (state.posS !== null) {
    const x = Math.round(xOf(state.posS) * dpr) / dpr
    ctx.fillStyle = tokens.playhead
    ctx.fillRect(x - 1, barTop - 2, 2, barHeight + 4)
  }

  // 7. hover line and label
  if (state.hover) drawHover(ctx, width, state.hover, tokens)
}

function drawHover(ctx: TimelineCtx, width: number, hover: { x: number; label: string }, tokens: TimelineTokens): void {
  const { barTop, barHeight } = LAYOUT
  const x = Math.min(Math.max(hover.x, 0), width)
  ctx.save()
  ctx.globalAlpha = 0.6
  ctx.fillStyle = tokens.text
  ctx.fillRect(x - 0.5, barTop, 1, barHeight)
  ctx.globalAlpha = 1
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const textWidth = ctx.measureText(hover.label).width
  const boxW = textWidth + 10
  const boxH = 16
  // keep the label inside the canvas, preferring the right side of the pointer
  const boxX = x + 6 + boxW <= width ? x + 6 : Math.max(0, x - 6 - boxW)
  const boxY = barTop + (barHeight - boxH) / 2
  ctx.fillStyle = tokens.surface
  ctx.fillRect(boxX, boxY, boxW, boxH)
  ctx.strokeStyle = tokens.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.rect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1)
  ctx.stroke()
  ctx.fillStyle = tokens.text
  ctx.fillText(hover.label, boxX + 5, boxY + boxH / 2)
  ctx.restore()
}

function inSpans(spans: readonly Span[], t: number): boolean {
  return spans.some(([s, e]) => t >= s && t < e)
}

export function stateAt(state: Pick<TimelineDrawState, 'downloaded' | 'downloading'>, t: number): SpanState {
  if (inSpans(state.downloaded, t)) return 'downloaded'
  if (inSpans(state.downloading, t)) return 'downloading'
  return 'missing'
}

const VIEWER_LABELS: Record<SpanState, string> = {
  downloaded: 'Downloaded',
  downloading: 'Downloading',
  missing: 'Not downloaded',
}
const HOST_LABELS: Record<SpanState, string> = {
  downloaded: 'Everyone has it',
  downloading: 'Sending',
  missing: 'Not everyone has it',
}

export function stateLabel(s: SpanState, isHost: boolean): string {
  return (isHost ? HOST_LABELS : VIEWER_LABELS)[s]
}

export function hoverLabel(state: TimelineDrawState, t: number, isHost: boolean): string {
  const parts = [formatTime(t), stateLabel(stateAt(state, t), isHost)]
  if (inSpans(state.buffered, t)) parts.push('buffered')
  return parts.join(' · ')
}

/** Fraction of the duration covered by spans (spans may overlap). */
export function coveredFraction(spans: readonly Span[], durationS: number | null): number {
  if (durationS === null || !(durationS > 0)) return 0
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  for (const [s, e] of sorted) {
    const start = Math.max(s, end, 0)
    const stop = Math.min(e, durationS)
    if (stop > start) total += stop - start
    end = Math.max(end, e)
  }
  return total / durationS
}
