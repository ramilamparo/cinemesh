// Types, statistics and the per-run analysis of the S6-lite spike (ADR 0007). s6.ts records raw samples and events;
// everything here is a pure function of a run.json, so summaries can be recomputed without measuring again.

export type Prop = 'audio-pts' | 'time-pos'

/**
 * One get_property round trip. All times are performance.now() ms: the clock MpvIpc stamps tSend/tRecv with and
 * the one the session's sync Clock (createClock) runs on.
 */
export interface Sample {
  /** phase: idle, play, speed:<x>:<k>, or a trial's A|B|C<i>:pre|p50|p300|post */
  ph: string
  prop: Prop
  /** PlayerController.sample() answered with time-pos because audio-pts failed */
  fb?: true
  /** MpvIpc: just before the request was written, and when the reply's bytes arrived */
  tS: number
  tR: number
  /** seconds; null when mpv answered with an error */
  v: number | null
  err?: string
  /** createClock().loopLagMs() when the reply was handled: what DriftController.offer gates on */
  lag: number
}

/** A command we sent (stamped just before the write) or an mpv event (stamped when the controller emitted it). */
export interface Ev {
  t: number
  k: string
  [key: string]: unknown
}

export interface RunMeta {
  tag: string
  /** fd://3 (default) or --input-ipc-server (absent in early runs: fd) */
  ipc?: 'fd' | 'socket'
  source: 'local' | 'stream'
  load: number
  seed: number
  fixture: string
  durationS: number
  fps: number
  mpv: string
  node: string
  /** the spawn line PlayerController logged */
  argv: string
  started: string
  finished: string
  /** /proc/loadavg at every phase boundary */
  loadavg: { at: string; t: number; text: string }[]
  /** content hash (16 hex) at the start, and the files whose mtime changed during the run */
  src: { hash: Record<string, string>; changed: string[] }
  protocols: string[]
  trials: number
  fitS: number
}

export interface EnvPoint {
  t: number
  /** 1-minute load average */
  la1: number
  /** runnable tasks (/proc/loadavg) */
  running: number
  /** /proc/pressure/cpu some avg10, % */
  psi10: number
}

export interface RunData {
  meta: RunMeta
  samples: Sample[]
  events: Ev[]
  env?: EnvPoint[]
}

// ---- statistics --------------------------------------------------------------------------------

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface Summary {
  n: number
  mean: number
  sd: number
  min: number
  p5: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function summary(xs: readonly number[]): Summary {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b)
  const n = s.length
  const mean = n ? s.reduce((a, b) => a + b, 0) / n : NaN
  const sd = n > 1 ? Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : NaN
  return {
    n,
    mean,
    sd,
    min: s[0] ?? NaN,
    p5: quantile(s, 0.05),
    p50: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    max: s[n - 1] ?? NaN,
  }
}

export function median(xs: readonly number[]): number {
  return quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  )
}

/** y = icpt + slope · (x − x0), least squares; sd is the residual standard deviation (n − 2). */
export interface Line {
  n: number
  x0: number
  icpt: number
  slope: number
  sd: number
  maxAbs: number
  res: number[]
}

export function fitLine(xs: readonly number[], ys: readonly number[], fixedSlope?: number): Line | null {
  const n = xs.length
  if (n < 3) return null
  const x0 = xs.reduce((a, b) => a + b, 0) / n
  const y0 = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - x0) ** 2
    sxy += (xs[i] - x0) * (ys[i] - y0)
  }
  const slope = fixedSlope ?? sxy / sxx
  const res = xs.map((x, i) => ys[i] - (y0 + slope * (x - x0)))
  const dof = fixedSlope === undefined ? n - 2 : n - 1
  const sd = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / dof)
  return { n, x0, icpt: y0, slope, sd, maxAbs: Math.max(...res.map(Math.abs)), res }
}

export const lineAt = (l: Line, x: number): number => l.icpt + l.slope * (x - l.x0)
/** x where the line reaches y */
export const crossing = (l: Line, y: number): number => l.x0 + (y - l.icpt) / l.slope

/** The drift loop's D: the median of the last 5 values, once 5 are in (DRIFT.MEDIAN_N). */
export function median5(xs: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 4; i < xs.length; i++) out.push(median(xs.slice(i - 4, i + 1)))
  return out
}

/**
 * Where mpv 0.41's exact seek lands, ms: hr-seek drops the frames before target − 5 ms, so it shows the first frame
 * at or after that (measured: probe in ADR 0007 §2). Assumes frames on a k · frameMs grid from 0.
 */
export function landingMs(targetS: number, frameMs: number): number {
  return Math.ceil((targetS * 1000 - 5) / frameMs - 1e-9) * frameMs
}

// ---- the drift loop's sample gate (src/core/sync/drift.ts DriftController.offer) -----------------

export const GATE = { rttMs: 15, lagMs: 20 }
export const gateOk = (s: Sample): boolean => s.tR - s.tS < GATE.rttMs && s.lag < GATE.lagMs
/**
 * monitorEventLoopDelay records the whole interval between its timer's runs, so an idle loop reads its resolution
 * (createClock: 10 ms). The gate as the plan states it (lag < 20 ms) is lag − 10 ms < 20 ms.
 */
export const LAG_TIMER_MS = 10
export const gateOkNoInterval = (s: Sample): boolean => s.tR - s.tS < GATE.rttMs && s.lag - LAG_TIMER_MS < GATE.lagMs

// ---- per-run analysis --------------------------------------------------------------------------

export const rtt = (s: Sample): number => s.tR - s.tS
const mid = (s: Sample): number => (s.tS + s.tR) / 2
const ok = (s: Sample): s is Sample & { v: number } => s.v !== null

export interface FitResult {
  windowS: number
  ap: {
    n: number
    slopePpm: number
    sd: number
    maxAbs: number
    gatedN: number
    gatedSd: number
    /** the drift loop's median-of-5 D against the fit line (gated samples) */
    med5Sd: number
    med5P99: number
  }
  tp: {
    n: number
    sd: number
    /** time-pos minus the audio-pts line at the same instant */
    biasMean: number
    biasSd: number
    biasMin: number
    biasMax: number
    /** |median-of-5 D| of a time-pos-only member, bias included */
    med5P99: number
  }
}

export interface SpeedResult {
  k: number
  speed: number
  n: number
  /** measured d(audio-pts)/dt over the segment, from 1 s after the change */
  rate: number
  errPct: number
  /**
   * The same against the run's 1x rate (median of its 1x segments). mpv's clock is CLOCK_MONOTONIC_RAW, ours
   * (performance.now()) CLOCK_MONOTONIC, which NTP slews: errPct carries that slew, this does not (unless it
   * changed during the run).
   */
  errVs1xPct: number
  sd: number
  tpRate: number
  tpErrPct: number
  /** where the old and the new line meet, after the set_property; null when the rates are within 0.5 % */
  changeMs: number | null
  reconfigs: number
}

/** A: pause while playing, read the paused position, unpause at a scheduled instant T (member.ts timing). */
export interface PauseTrial {
  i: number
  /** set_property pause=no written this long after T (setTimeout 15 ms early + setImmediate spin) */
  lateMs: number
  /** paused audio-pts minus the playing line at the pause command (≈ how long mpv kept playing) */
  pausedErrMs: number
  /** paused audio-pts 300 ms later minus 50 ms later */
  pausedDriftMs: number
  /** paused time-pos minus paused audio-pts */
  tpLeadMs: number
  /** the new line reaches the paused position this long after the command: mpv's unpause latency */
  latMs: number
  /** ... and after T: what the member's start sees (lateness included) */
  vsTMs: number
  /** member.ts's estimate (first gated sample ≥ 300 ms, fromPos = the paused audio-pts), unclamped */
  estMs: number | null
  postSd: number
  postRate: number
}

/** B: exact seek while paused, read the paused position, then unpause at T. */
export interface PausedSeekTrial {
  i: number
  target: number
  seekMs: number
  /** paused audio-pts minus the target, 50 and 300 ms after playback-restart */
  ap50Ms: number
  ap300Ms: number
  /** paused time-pos minus the target, and minus where hr-seek lands (the first frame ≥ target − 5 ms) */
  tpMs: number
  tpVsFrameMs: number
  lateMs: number
  /** the new line reaches the paused time-pos (the frame) / the target this long after the command */
  latFrameMs: number
  latTargetMs: number
  /** member.ts's estimate with fromPos = the target, unclamped */
  estMs: number | null
}

/** C: exact seek while playing (half are drift-loop skips of +1.5 s). */
export interface PlayingSeekTrial {
  i: number
  short: boolean
  target: number
  /** command → playback-restart: what the drift loop's seekLat EWMA learns */
  seekMs: number
  /** the post-seek line reaches the target / the landing frame (first ≥ target − 5 ms) this long after the command */
  effMs: number
  effFrameMs: number
  /** D right after a skip whose seekLat equals this seek's restart latency (+ = ahead) */
  landMs: number
}

export interface RunResult {
  meta: RunMeta
  env: EnvPoint[]
  /** RTT of the 4 Hz samples (sync's cadence), by state and property; 20 Hz trial samples apart */
  rtt: Record<'idle' | 'play' | 'dense', Record<Prop, number[]>>
  /** the gate on the production samples (sample() = audio-pts) at 4 Hz while playing */
  gate: { n: number; ok: number; badRtt: number; badLag: number; badBoth: number; okNoInterval: number }
  lag: { idle: number[]; play: number[] }
  fallbacks: number
  errors: number
  fit: FitResult | null
  speeds: SpeedResult[]
  pause: PauseTrial[]
  pseek: PausedSeekTrial[]
  rseek: PlayingSeekTrial[]
}

function byPh(samples: readonly Sample[], ph: string, prop: Prop): (Sample & { v: number })[] {
  return samples.filter((s) => s.ph === ph && s.prop === prop && !s.fb).filter(ok)
}

const firstAfter = (events: readonly Ev[], k: string, t: number): Ev | undefined =>
  events.find((e) => e.k === k && e.t > t)

/** The line through a phase's audio-pts samples taken from `fromT` on. */
function postLine(samples: readonly Sample[], ph: string, fromT: number): Line | null {
  const s = byPh(samples, ph, 'audio-pts').filter((x) => mid(x) >= fromT)
  return fitLine(
    s.map(mid),
    s.map((x) => x.v * 1000),
  )
}

export function analyzeRun(data: RunData): RunResult {
  const { samples, events, meta } = data
  const frameMs = 1000 / meta.fps
  const ceilFrameMs = (s: number): number => landingMs(s, frameMs)
  const groupOf = (ph: string): 'idle' | 'play' | 'dense' =>
    ph === 'idle' ? 'idle' : ph === 'play' || ph.startsWith('speed:') ? 'play' : 'dense'
  const rtts: RunResult['rtt'] = {
    idle: { 'audio-pts': [], 'time-pos': [] },
    play: { 'audio-pts': [], 'time-pos': [] },
    dense: { 'audio-pts': [], 'time-pos': [] },
  }
  const gate = { n: 0, ok: 0, badRtt: 0, badLag: 0, badBoth: 0, okNoInterval: 0 }
  const lag: RunResult['lag'] = { idle: [], play: [] }
  for (const s of samples) {
    if (s.v === null) continue
    const g = groupOf(s.ph)
    rtts[g][s.prop].push(rtt(s))
    if (g === 'dense') continue
    if (s.prop === 'audio-pts' || s.fb) lag[g].push(s.lag)
    // only sample()'s answers count, as in member.ts onSample
    if (g !== 'play' || (s.prop !== 'audio-pts' && !s.fb)) continue
    gate.n++
    if (gateOkNoInterval(s)) gate.okNoInterval++
    const r = rtt(s) >= GATE.rttMs
    const l = s.lag >= GATE.lagMs
    if (!r && !l) gate.ok++
    else if (r && l) gate.badBoth++
    else if (r) gate.badRtt++
    else gate.badLag++
  }

  // ---- 60 s fit at 1x ----
  let fit: FitResult | null = null
  const unpauseFit = events.find((e) => e.k === 'unpause' && e.kind === 'fit')
  if (unpauseFit) {
    const from = unpauseFit.t + 1000
    const to = from + meta.fitS * 1000
    const inWin = (s: Sample): boolean => mid(s) >= from && mid(s) <= to
    const ap = byPh(samples, 'play', 'audio-pts').filter(inWin)
    const tp = byPh(samples, 'play', 'time-pos').filter(inWin)
    const apLine = fitLine(
      ap.map(mid),
      ap.map((s) => s.v * 1000),
    )
    if (apLine) {
      const gated = ap.filter(gateOk)
      const gLine = fitLine(
        gated.map(mid),
        gated.map((s) => s.v * 1000),
      )
      const gRes = gated.map((s) => s.v * 1000 - lineAt(apLine, mid(s)))
      const d5 = median5(gRes).map(Math.abs)
      const bias = tp.map((s) => s.v * 1000 - lineAt(apLine, mid(s)))
      const tpLine = fitLine(
        tp.map(mid),
        tp.map((s) => s.v * 1000),
      )
      const bs = summary(bias)
      fit = {
        windowS: meta.fitS,
        ap: {
          n: apLine.n,
          slopePpm: (apLine.slope - 1) * 1e6,
          sd: apLine.sd,
          maxAbs: apLine.maxAbs,
          gatedN: gated.length,
          gatedSd: gLine?.sd ?? NaN,
          med5Sd: summary(median5(gRes)).sd,
          med5P99: summary(d5).p99,
        },
        tp: {
          n: tp.length,
          sd: tpLine?.sd ?? NaN,
          biasMean: bs.mean,
          biasSd: bs.sd,
          biasMin: bs.min,
          biasMax: bs.max,
          med5P99: summary(median5(bias).map(Math.abs)).p99,
        },
      }
    }
  }

  // ---- speed segments ----
  const speeds: SpeedResult[] = []
  const speedEvs = events.filter((e) => e.k === 'speed')
  let prev: Line | null = null
  if (unpauseFit) {
    const play = byPh(samples, 'play', 'audio-pts').filter((s) => mid(s) >= unpauseFit.t + 1000)
    prev = fitLine(
      play.map(mid),
      play.map((s) => s.v * 1000),
    )
  }
  for (const e of speedEvs) {
    const k = Number(e.seg)
    const speed = Number(e.speed)
    const ph = `speed:${String(speed)}:${String(k)}`
    const ap = byPh(samples, ph, 'audio-pts').filter((s) => mid(s) >= e.t + 1000)
    const tp = byPh(samples, ph, 'time-pos').filter((s) => mid(s) >= e.t + 1000)
    const l = fitLine(
      ap.map(mid),
      ap.map((s) => s.v * 1000),
    )
    const lt = fitLine(
      tp.map(mid),
      tp.map((s) => s.v * 1000),
    )
    if (!l) continue
    const next = events.find((x) => x.t > e.t && (x.k === 'speed' || x.k === 'pause'))
    const reconfigs = events.filter((x) => x.k === 'audio-reconfig' && x.t >= e.t && x.t < (next?.t ?? Infinity)).length
    let changeMs: number | null = null
    if (prev && Math.abs(l.slope - prev.slope) > 0.005) {
      // icpt_p + s_p (x − x0_p) = icpt_l + s_l (x − x0_l)
      const x = (l.icpt - prev.icpt + prev.slope * prev.x0 - l.slope * l.x0) / (prev.slope - l.slope)
      changeMs = x - e.t
    }
    speeds.push({
      k,
      speed,
      n: l.n,
      rate: l.slope,
      errPct: (l.slope / speed - 1) * 100,
      errVs1xPct: NaN,
      sd: l.sd,
      tpRate: lt?.slope ?? NaN,
      tpErrPct: lt ? (lt.slope / speed - 1) * 100 : NaN,
      changeMs,
      reconfigs,
    })
    prev = l
  }
  const base = median(speeds.filter((x) => x.speed === 1).map((x) => x.rate))
  for (const x of speeds) x.errVs1xPct = (x.rate / x.speed / base - 1) * 100

  // ---- A: pause while playing, unpause at T ----
  const pause: PauseTrial[] = []
  for (const u of events.filter((e) => e.k === 'unpause' && e.kind === 'A')) {
    const i = Number(u.i)
    const p = events.find((e) => e.k === 'pause' && e.kind === 'A' && e.i === i)
    const pre = byPh(samples, `A${String(i)}:pre`, 'audio-pts')
    const p50 = byPh(samples, `A${String(i)}:p50`, 'audio-pts')[0]
    const p300 = byPh(samples, `A${String(i)}:p300`, 'audio-pts')[0]
    const tp50 = byPh(samples, `A${String(i)}:p50`, 'time-pos')[0]
    const preLine = fitLine(
      pre.map(mid),
      pre.map((s) => s.v * 1000),
    )
    const post = postLine(samples, `A${String(i)}:post`, u.t + 500)
    if (!p || !p50 || !p300 || !tp50 || !preLine || !post) continue
    const P0 = p300.v * 1000
    const x = crossing(post, P0)
    const est = byPh(samples, `A${String(i)}:post`, 'audio-pts').find((s) => mid(s) - u.t >= 300 && gateOk(s))
    pause.push({
      i,
      lateMs: u.t - Number(u.T),
      pausedErrMs: p50.v * 1000 - lineAt(preLine, p.t),
      pausedDriftMs: (p300.v - p50.v) * 1000,
      tpLeadMs: (tp50.v - p50.v) * 1000,
      latMs: x - u.t,
      vsTMs: x - Number(u.T),
      estMs: est ? mid(est) - (est.v * 1000 - P0) - u.t : null,
      postSd: post.sd,
      postRate: post.slope,
    })
  }

  // ---- B: exact seek while paused, unpause at T ----
  const pseek: PausedSeekTrial[] = []
  for (const sk of events.filter((e) => e.k === 'seek' && e.kind === 'B')) {
    const i = Number(sk.i)
    const target = Number(sk.target)
    const rs = firstAfter(events, 'restart', sk.t)
    const u = events.find((e) => e.k === 'unpause' && e.kind === 'B' && e.i === i)
    const a50 = byPh(samples, `B${String(i)}:p50`, 'audio-pts')[0]
    const a300 = byPh(samples, `B${String(i)}:p300`, 'audio-pts')[0]
    const t50 = byPh(samples, `B${String(i)}:p50`, 'time-pos')[0]
    if (!rs || !u || !a50 || !a300 || !t50) continue
    const post = postLine(samples, `B${String(i)}:post`, u.t + 500)
    if (!post) continue
    const est = byPh(samples, `B${String(i)}:post`, 'audio-pts').find((s) => mid(s) - u.t >= 300 && gateOk(s))
    pseek.push({
      i,
      target,
      seekMs: rs.t - sk.t,
      ap50Ms: (a50.v - target) * 1000,
      ap300Ms: (a300.v - target) * 1000,
      tpMs: (t50.v - target) * 1000,
      tpVsFrameMs: t50.v * 1000 - ceilFrameMs(target),
      lateMs: u.t - Number(u.T),
      latFrameMs: crossing(post, t50.v * 1000) - u.t,
      latTargetMs: crossing(post, target * 1000) - u.t,
      estMs: est ? mid(est) - (est.v - target) * 1000 - u.t : null,
    })
  }

  // ---- C: exact seek while playing ----
  const rseek: PlayingSeekTrial[] = []
  for (const sk of events.filter((e) => e.k === 'seek' && e.kind === 'C')) {
    const i = Number(sk.i)
    const target = Number(sk.target)
    const rs = firstAfter(events, 'restart', sk.t)
    if (!rs) continue
    const post = postLine(samples, `C${String(i)}:post`, rs.t + 300)
    if (!post) continue
    const eff = crossing(post, target * 1000) - sk.t
    rseek.push({
      i,
      short: sk.short === true,
      target,
      seekMs: rs.t - sk.t,
      effMs: eff,
      effFrameMs: crossing(post, ceilFrameMs(target)) - sk.t,
      landMs: rs.t - sk.t - eff,
    })
  }

  return {
    meta,
    env: data.env ?? [],
    rtt: rtts,
    gate,
    lag,
    fallbacks: samples.filter((s) => s.fb).length,
    errors: samples.filter((s) => s.v === null).length,
    fit,
    speeds,
    pause,
    pseek,
    rseek,
  }
}
