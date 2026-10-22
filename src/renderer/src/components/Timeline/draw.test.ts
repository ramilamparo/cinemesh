import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '../../../../shared/theme-tokens'
import {
  LAYOUT,
  type TimelineCtx,
  type TimelineDrawState,
  coveredFraction,
  drawTimeline,
  hoverLabel,
  stateAt,
} from './draw'

interface Op {
  op: string
  args: number[] | string[]
  fill: string
  stroke: string
  alpha: number
}

/** Records every call together with the style in effect, like a canvas spy. Styles are plain colour strings. */
class RecordingCtx {
  readonly ops: Op[] = []
  fillStyle = '#000000'
  strokeStyle = '#000000'
  lineWidth = 1
  globalAlpha = 1
  font = ''
  textBaseline: CanvasTextBaseline = 'alphabetic'
  textAlign: CanvasTextAlign = 'start'
  private readonly stack: { fill: string; stroke: string; alpha: number }[] = []

  save(): void {
    this.stack.push({ fill: this.fillStyle, stroke: this.strokeStyle, alpha: this.globalAlpha })
    this.rec('save', [])
  }
  restore(): void {
    const s = this.stack.pop()
    if (s) {
      this.fillStyle = s.fill
      this.strokeStyle = s.stroke
      this.globalAlpha = s.alpha
    }
    this.rec('restore', [])
  }
  measureText(t: string): TextMetrics {
    return { width: t.length * 6 } as TextMetrics
  }
  setTransform(...a: number[]): void {
    this.rec('setTransform', a)
  }
  clearRect(...a: number[]): void {
    this.rec('clearRect', a)
  }
  fillRect(...a: number[]): void {
    this.rec('fillRect', a)
  }
  beginPath(): void {
    this.rec('beginPath', [])
  }
  moveTo(...a: number[]): void {
    this.rec('moveTo', a)
  }
  lineTo(...a: number[]): void {
    this.rec('lineTo', a)
  }
  closePath(): void {
    this.rec('closePath', [])
  }
  fill(): void {
    this.rec('fill', [])
  }
  stroke(): void {
    this.rec('stroke', [])
  }
  rect(...a: number[]): void {
    this.rec('rect', a)
  }
  clip(): void {
    this.rec('clip', [])
  }
  fillText(text: string, x: number, y: number): void {
    this.rec('fillText', [text, String(x), String(y)])
  }
  private rec(op: string, args: number[] | string[]): void {
    this.ops.push({ op, args, fill: this.fillStyle, stroke: this.strokeStyle, alpha: this.globalAlpha })
  }
}

function recordingCtx(): TimelineCtx & { ops: Op[] } {
  return new RecordingCtx() as unknown as TimelineCtx & { ops: Op[] }
}

const tokens = THEME_TOKENS.light
const size = { width: 1000, height: 44, dpr: 2 }

function state(patch: Partial<TimelineDrawState> = {}): TimelineDrawState {
  return {
    durationS: 100,
    downloaded: [],
    downloading: [],
    buffered: [],
    posS: null,
    markers: [],
    hover: null,
    ...patch,
  }
}

const fills = (ops: Op[], color: string): number[][] =>
  ops.filter((o) => o.op === 'fillRect' && o.fill === color).map((o) => o.args as number[])

describe('drawTimeline', () => {
  it('applies the DPR transform and clears in CSS pixels', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, size, state(), tokens)
    expect(ctx.ops[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] })
    expect(ctx.ops[1]).toMatchObject({ op: 'clearRect', args: [0, 0, 1000, 44] })
  })

  it('draws only the missing track when the duration is unknown', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, size, state({ durationS: null, downloaded: [[0, 50]], posS: 10 }), tokens)
    expect(fills(ctx.ops, tokens['tl-missing'])).toEqual([[0, LAYOUT.barTop, 1000, LAYOUT.barHeight]])
    expect(ctx.ops.filter((o) => o.op === 'fillRect')).toHaveLength(1)
  })

  it('draws the layers bottom to top at the right positions', () => {
    const ctx = recordingCtx()
    drawTimeline(
      ctx,
      size,
      state({
        downloaded: [[0, 25]],
        downloading: [[25, 30]],
        buffered: [[10, 20]],
        posS: 12,
        markers: [{ id: 'a', name: 'Ola', posS: 50, color: '#ff0000' }],
      }),
      tokens,
    )
    const { barTop, barHeight } = LAYOUT
    expect(fills(ctx.ops, tokens['tl-missing'])).toEqual([[0, barTop, 1000, barHeight]])
    expect(fills(ctx.ops, tokens['tl-downloaded'])).toEqual([[0, barTop, 250, barHeight]])
    expect(fills(ctx.ops, tokens['tl-downloading'])).toEqual([[250, barTop, 50, barHeight]])
    expect(fills(ctx.ops, tokens['tl-buffered'])).toEqual([[100, LAYOUT.bufferedTop, 100, LAYOUT.bufferedHeight]])
    expect(fills(ctx.ops, tokens.playhead)).toEqual([[119, barTop - 2, 2, barHeight + 4]])

    const order = ctx.ops.map((o) => `${o.op}:${o.fill}`)
    const idx = (s: string): number => order.findIndex((x) => x === s)
    expect(idx(`fillRect:${tokens['tl-missing']}`)).toBeLessThan(idx(`fillRect:${tokens['tl-downloaded']}`))
    expect(idx(`fillRect:${tokens['tl-downloaded']}`)).toBeLessThan(idx(`fillRect:${tokens['tl-downloading']}`))
    expect(idx(`fillRect:${tokens['tl-downloading']}`)).toBeLessThan(idx(`fillRect:${tokens['tl-buffered']}`))
    expect(idx(`fillRect:${tokens['tl-buffered']}`)).toBeLessThan(idx('fill:#ff0000'))
    expect(idx('fill:#ff0000')).toBeLessThan(idx(`fillRect:${tokens.playhead}`))
  })

  it('stripes downloading spans at 45° inside a clip so state is not colour-only', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, size, state({ downloading: [[50, 60]] }), tokens)
    const clipAt = ctx.ops.findIndex((o) => o.op === 'clip')
    expect(clipAt).toBeGreaterThan(0)
    expect(ctx.ops[clipAt - 1]).toMatchObject({ op: 'rect', args: [500, LAYOUT.barTop, 100, LAYOUT.barHeight] })
    const lines = ctx.ops.filter((o) => o.op === 'lineTo')
    expect(lines.length).toBeGreaterThan(10)
    const moves = ctx.ops.filter((o) => o.op === 'moveTo')
    lines.forEach((line, i) => {
      const [x0 = 0, y0 = 0] = moves[i]?.args as number[]
      const [x1 = 0, y1 = 0] = line.args as number[]
      expect(x1 - x0).toBeCloseTo(y0 - y1) // 45°
    })
    const stroke = ctx.ops.find((o) => o.op === 'stroke')
    expect(stroke).toMatchObject({ stroke: tokens.bg, alpha: 0.5 })
    expect(ctx.ops.filter((o) => o.op === 'save').length).toBe(ctx.ops.filter((o) => o.op === 'restore').length)
  })

  it('gives tiny spans at least one pixel and clamps spans to the duration', () => {
    const ctx = recordingCtx()
    drawTimeline(
      ctx,
      size,
      state({
        downloaded: [
          [10, 10.001],
          [90, 500],
        ],
      }),
      tokens,
    )
    expect(fills(ctx.ops, tokens['tl-downloaded'])).toEqual([
      [100, LAYOUT.barTop, 1, LAYOUT.barHeight],
      [900, LAYOUT.barTop, 100, LAYOUT.barHeight],
    ])
  })

  it('draws peer markers as triangles in their colour', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, size, state({ markers: [{ id: 'a', name: 'A', posS: 20, color: '#123456' }] }), tokens)
    const fill = ctx.ops.find((o) => o.op === 'fill')
    expect(fill?.fill).toBe('#123456')
    const moveTo = ctx.ops.find((o) => o.op === 'moveTo')
    expect(moveTo?.args).toEqual([195.5, 0])
  })

  it('draws the hover label inside the canvas', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, size, state({ hover: { x: 995, label: '1:39 · Downloaded' } }), tokens)
    const textOp = ctx.ops.find((o) => o.op === 'fillText')
    expect(textOp?.args[0]).toBe('1:39 · Downloaded')
    expect(Number(textOp?.args[1])).toBeLessThan(995)
    expect(textOp?.fill).toBe(tokens.text)
  })

  it('does nothing beyond clearing at zero width', () => {
    const ctx = recordingCtx()
    drawTimeline(ctx, { width: 0, height: 44, dpr: 1 }, state({ downloaded: [[0, 1]] }), tokens)
    expect(ctx.ops.map((o) => o.op)).toEqual(['setTransform', 'clearRect'])
  })
})

describe('timeline helpers', () => {
  const s = state({ downloaded: [[0, 10]], downloading: [[10, 12]], buffered: [[5, 8]] })

  it('classifies a position', () => {
    expect(stateAt(s, 5)).toBe('downloaded')
    expect(stateAt(s, 11)).toBe('downloading')
    expect(stateAt(s, 50)).toBe('missing')
  })

  it('labels hover positions for viewers and the host', () => {
    expect(hoverLabel(s, 6, false)).toBe('0:06 · Downloaded · buffered')
    expect(hoverLabel(s, 6, true)).toBe('0:06 · Everyone has it · buffered')
    expect(hoverLabel(s, 70, true)).toBe('1:10 · Not everyone has it')
  })

  it('measures coverage with overlapping spans', () => {
    expect(
      coveredFraction(
        [
          [0, 10],
          [5, 20],
          [90, 200],
        ],
        100,
      ),
    ).toBeCloseTo(0.3)
    expect(coveredFraction([[0, 10]], null)).toBe(0)
  })
})
