import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatPercent, formatTime } from '../../lib/format'
import { peerColor, resolvePalette } from '../../lib/theme'
import { sendIntent } from '../../rpc'
import { isLeaving, playhead, useApp } from '../../store'
import {
  TIMELINE_HEIGHT,
  type TimelineDrawState,
  type TimelineMarker,
  coveredFraction,
  drawTimeline,
  hoverLabel,
} from './draw'
import styles from './Timeline.module.css'

const EMPTY: [number, number][] = []

/** Three-state download timeline with the playhead and peer markers (plan §4.6, R8). */
export function Timeline(): React.JSX.Element {
  const timeline = useApp((s) => s.core.timeline)
  const playback = useApp((s) => s.core.playback)
  const peers = useApp((s) => s.core.peers)
  // not a form control, so the Room's disabled fieldset does not lock it: a leave or save in progress does
  const locked = useApp(isLeaving)
  const canSeek = useApp((s) => s.core.sync?.canSeek ?? false) && !locked
  const isHost = useApp((s) => s.core.session?.role === 'host')
  const theme = useApp((s) => s.theme)
  const palette = useMemo(() => resolvePalette(theme), [theme])

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, dpr: 1 })
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [dragX, setDragX] = useState<number | null>(null)

  const durationS = timeline?.durationS ?? playback?.durationS ?? null
  const downloaded = (isHost ? timeline?.groupDone : timeline?.done) ?? EMPTY

  const markers = useMemo<TimelineMarker[]>(
    () =>
      (peers ?? []).flatMap((p, i) =>
        !p.self && typeof p.posS === 'number'
          ? [{ id: p.id, name: p.name, posS: p.posS, color: peerColor(palette.peers, i) }]
          : [],
      ),
    [peers, palette],
  )

  const baseState = useMemo(
    () => ({
      durationS,
      downloaded,
      downloading: timeline?.loading ?? EMPTY,
      buffered: timeline?.buffered ?? EMPTY,
      markers,
    }),
    [durationS, downloaded, timeline, markers],
  )

  const timeAt = useCallback(
    (x: number): number =>
      durationS && size.width > 0 ? (Math.min(Math.max(x, 0), size.width) / size.width) * durationS : 0,
    [durationS, size.width],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const pointer = dragX ?? hoverX
    const state: TimelineDrawState = {
      ...baseState,
      posS: playhead.position(performance.now()),
      hover:
        pointer === null
          ? null
          : { x: pointer, label: hoverLabel({ ...baseState, posS: null, hover: null }, timeAt(pointer), isHost) },
    }
    drawTimeline(ctx, { width: size.width, height: TIMELINE_HEIGHT, dpr: size.dpr }, state, palette.colors)
  }, [baseState, dragX, hoverX, isHost, palette, size, timeAt])

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setSize({ width: w, dpr: window.devicePixelRatio || 1 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // DPR changes (window moved to another monitor) do not resize the element.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(`(resolution: ${String(size.dpr)}dppx)`)
    const onChange = (): void => setSize((s) => ({ ...s, dpr: window.devicePixelRatio || 1 }))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [size.dpr])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = Math.round(size.width * size.dpr)
    canvas.height = Math.round(TIMELINE_HEIGHT * size.dpr)
  }, [size])

  // Redraw on any change, and every frame while playback moves; always inside an animation frame. A draw outside
  // one makes Chromium's 2D-canvas rate limiter block the main thread on the GPU process, which on X11 waits for
  // the previous swap: ~1 s per draw while the window is not shown (screen locked, other workspace, behind mpv).
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') {
      draw()
      return
    }
    let raf = requestAnimationFrame(function frame() {
      draw()
      if (playhead.moving) raf = requestAnimationFrame(frame)
    })
    return () => cancelAnimationFrame(raf)
  }, [draw, playback])

  const localX = (e: React.PointerEvent): number => e.clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!canSeek || !durationS || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragX(localX(e))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const x = localX(e)
    setHoverX(x)
    if (dragX !== null) setDragX(x)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragX === null) return
    const posS = timeAt(localX(e))
    setDragX(null)
    if (canSeek) void sendIntent({ kind: 'seek', posS })
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const delta = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : null
    if (delta === null || e.altKey || e.ctrlKey || e.metaKey || locked) return
    e.preventDefault()
    // one seek per press, as the room-wide keys do: a held key's repeats would flood the host with intents
    if (e.repeat) return
    void sendIntent({ kind: 'seekRel', deltaS: delta })
  }

  const posS = playback?.posS ?? 0
  const have = coveredFraction(downloaded, durationS)
  const valueText = `${formatTime(posS)} of ${formatTime(durationS)}, ${formatPercent(have)} ${isHost ? 'with everyone' : 'downloaded'}`

  return (
    <div className={styles.timeline}>
      <div
        ref={wrapRef}
        className={styles.track}
        data-seekable={canSeek || undefined}
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationS ?? 0)}
        aria-valuenow={Math.round(posS)}
        aria-valuetext={valueText}
        aria-disabled={!canSeek}
        title={canSeek ? undefined : locked ? 'Leaving the room' : 'Only the host can seek right now'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragX(null)}
        onPointerLeave={() => setHoverX(null)}
        onKeyDown={onKeyDown}
        data-testid="timeline"
      >
        <canvas ref={canvasRef} className={styles.canvas} style={{ height: TIMELINE_HEIGHT }} aria-hidden="true" />
      </div>
      <div className={styles.legend} aria-hidden="true">
        <span>
          <i className={styles.swDownloaded} /> {isHost ? 'Everyone has it' : 'Downloaded'}
        </span>
        <span>
          <i className={styles.swDownloading} /> {isHost ? 'Sending' : 'Downloading'}
        </span>
        <span>
          <i className={styles.swMissing} /> {isHost ? 'Not everyone has it' : 'Not downloaded'}
        </span>
        <span>
          <i className={styles.swBuffered} /> Buffered
        </span>
        <span className={styles.times}>
          {formatTime(posS)} / {formatTime(durationS)}
        </span>
      </div>
    </div>
  )
}
