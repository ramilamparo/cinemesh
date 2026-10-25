import type { TracksEvent, TrackInfo as PlayerTrack } from '../../shared/ipc/core.js'
import type { TrackInfo as MediaTrack } from '../../shared/media/types.js'

/**
 * Keeping the audio and subtitle choice across playlist items (ADR 0011 §7). At a switch the member captures what
 * mpv plays (captureChoice); planCarry finds the same track in the next item, from its manifest, before the
 * loadfile, so the choice goes into the loadfile's per-file options and nothing changes tracks after the file
 * opened (which can stall a viewer behind a blocked read). Each member does this for itself: track choice is local.
 *
 * Matching, per type: the same title (trimmed, case-insensitive), ties broken by the same language and then the
 * same position among that type's tracks; else the same language (and forced flag); else nothing, and mpv's
 * defaults (--alang/--slang) choose. Subtitles off stays off. External subtitles are titled by file name, which
 * changes per episode, so they match by language and forced flag only.
 */

/** What identifies a track across files. `index` is its position among the tracks of its type (0-based). */
export interface TrackSig {
  title: string | null
  lang: string | null
  codec: string | null
  forced: boolean
  external: boolean
  index: number
}

/** null: nothing to carry (no track of that type, or mpv had not chosen one). */
export interface CarryChoice {
  audio: TrackSig | null
  sub: TrackSig | 'no' | null
}

/** One external subtitle file of the next item, in the order the player adds them. */
export interface CarrySub {
  lang: string
  forced: boolean
}

export interface CarryPlan {
  /** mpv's audio id in the next file (per-type ids count from 1 in container order) */
  aid?: number
  /** the wanted language, so mpv still picks a same-language track if `aid` turned out wrong */
  alang?: string
  /** an embedded subtitle's mpv id, or 'no' to keep subtitles off */
  sid?: number | 'no'
  /** index into the next item's external subtitles: add that one with `select` */
  externalSub?: number
  /** what the chosen tracks should look like once loaded, to check the id mapping */
  verify: { audio?: Expect; sub?: Expect }
}

export interface Expect {
  title: string | null
  lang: string | null
}

export function captureChoice(t: Pick<TracksEvent, 'audio' | 'sub' | 'aid' | 'sid'>): CarryChoice {
  return {
    audio: sigOf(t.audio, t.aid),
    sub: t.sid === 'no' ? (t.sub.length > 0 ? 'no' : null) : sigOf(t.sub, t.sid),
  }
}

function sigOf(list: readonly PlayerTrack[], id: number | 'no'): TrackSig | null {
  if (id === 'no') return null
  const embedded = list.filter((x) => !x.external)
  const x = list.find((y) => y.id === id)
  if (!x) return null
  return {
    title: clean(x.title),
    lang: clean(x.lang),
    codec: clean(x.codec),
    forced: x.forced,
    external: x.external,
    index: x.external ? list.filter((y) => y.external).indexOf(x) : embedded.indexOf(x),
  }
}

/** A track of the next item to match against, in its type's order. */
interface Candidate {
  title: string | null
  lang: string | null
  forced: boolean
  external: boolean
  /** position among the candidates of its kind (embedded or external) */
  index: number
}

export function planCarry(
  choice: CarryChoice,
  tracks: readonly Pick<MediaTrack, 'type' | 'name' | 'lang' | 'forced'>[],
  externalSubs: readonly CarrySub[] = [],
): CarryPlan {
  const plan: CarryPlan = { verify: {} }
  const embedded = (type: 'audio' | 'subtitle'): Candidate[] =>
    tracks
      .filter((t) => t.type === type)
      .map((t, index) => ({ title: clean(t.name), lang: clean(t.lang), forced: t.forced, external: false, index }))

  if (choice.audio) {
    const audio = embedded('audio')
    const hit = matchTrack(choice.audio, audio)
    if (hit) {
      plan.aid = hit.index + 1
      plan.verify.audio = { title: hit.title, lang: hit.lang }
    }
    if (choice.audio.lang && isLangCode(choice.audio.lang)) plan.alang = (hit?.lang ?? choice.audio.lang).trim()
  }

  if (choice.sub === 'no') {
    plan.sid = 'no'
  } else if (choice.sub) {
    const subs = [
      ...embedded('subtitle'),
      ...externalSubs.map((s, index) => ({
        title: null,
        lang: clean(s.lang),
        forced: s.forced,
        external: true,
        index,
      })),
    ]
    const hit = matchTrack(choice.sub, subs)
    if (hit?.external) {
      plan.externalSub = hit.index
    } else if (hit) {
      plan.sid = hit.index + 1
      plan.verify.sub = { title: hit.title, lang: hit.lang }
    }
  }
  return plan
}

/** The candidate the rule above picks for `want`, or null for "let mpv choose". */
export function matchTrack<C extends Candidate>(want: TrackSig, candidates: readonly C[]): C | null {
  if (want.title !== null && !want.external) {
    const title = want.title.toLowerCase()
    const named = candidates.filter((c) => !c.external && c.title?.toLowerCase() === title)
    if (named.length > 0) return closest(want, named, true)
  }
  if (want.lang === null) return null
  const lang = candidates.filter((c) => sameLang(c.lang, want.lang) && c.forced === want.forced)
  if (lang.length === 0) return null
  // a choice among same-language tracks: keep the kind (embedded or external) the member chose, when there is one
  const kind = lang.filter((c) => c.external === want.external)
  return closest(want, kind.length > 0 ? kind : lang, false)
}

/** Of a non-empty list: the same language first (when asked), then the nearest position, then the first. */
function closest<C extends Candidate>(want: TrackSig, list: readonly C[], byLang: boolean): C | null {
  let pool = list
  if (byLang && want.lang !== null) {
    const same = list.filter((c) => sameLang(c.lang, want.lang))
    if (same.length > 0) pool = same
  }
  let best: C | null = null
  for (const c of pool) {
    const d = Math.abs(c.index - want.index)
    if (!best || d < Math.abs(best.index - want.index)) best = c
  }
  return best
}

function clean(s: string | null | undefined): string | null {
  const t = s?.trim()
  return t ? t : null
}

const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

function isLangCode(s: string): boolean {
  return LANG_RE.test(s.trim())
}

/**
 * ISO 639-1 to 639-2 (both the bibliographic and the terminology code where they differ), for the languages files
 * commonly carry. Matroska and MP4 store 639-2, BCP 47 tags and subtitle file names mostly use 639-1.
 */
const ISO1_TO_2: Readonly<Record<string, readonly string[]>> = {
  ar: ['ara'],
  bg: ['bul'],
  bn: ['ben'],
  ca: ['cat'],
  cs: ['cze', 'ces'],
  da: ['dan'],
  de: ['ger', 'deu'],
  el: ['gre', 'ell'],
  en: ['eng'],
  es: ['spa'],
  et: ['est'],
  eu: ['baq', 'eus'],
  fa: ['per', 'fas'],
  fi: ['fin'],
  fr: ['fre', 'fra'],
  gl: ['glg'],
  he: ['heb'],
  hi: ['hin'],
  hr: ['hrv'],
  hu: ['hun'],
  id: ['ind'],
  is: ['ice', 'isl'],
  it: ['ita'],
  ja: ['jpn'],
  ko: ['kor'],
  lt: ['lit'],
  lv: ['lav'],
  ms: ['may', 'msa'],
  nb: ['nob'],
  nl: ['dut', 'nld'],
  nn: ['nno'],
  no: ['nor'],
  pl: ['pol'],
  pt: ['por'],
  ro: ['rum', 'ron'],
  ru: ['rus'],
  sk: ['slo', 'slk'],
  sl: ['slv'],
  sr: ['srp'],
  sv: ['swe'],
  ta: ['tam'],
  te: ['tel'],
  th: ['tha'],
  tl: ['tgl'],
  tr: ['tur'],
  uk: ['ukr'],
  ur: ['urd'],
  vi: ['vie'],
  zh: ['chi', 'zho'],
}

const TO_CANON = new Map<string, string>()
for (const [two, threes] of Object.entries(ISO1_TO_2)) {
  TO_CANON.set(two, two)
  for (const t of threes) TO_CANON.set(t, two)
}
TO_CANON.set('fil', 'tl')

/** 'en', 'eng' and 'en-US' are one language; 'pt-BR' and 'pt-PT' are not, but 'pt' matches either. */
export function sameLang(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const [ab, ar] = splitLang(a)
  const [bb, br] = splitLang(b)
  if (ab === '' || ab === 'und' || ab !== bb) return false
  return ar === '' || br === '' || ar === br
}

function splitLang(s: string): [base: string, region: string] {
  const [base = '', ...rest] = s.trim().toLowerCase().split(/[-_]/)
  return [TO_CANON.get(base) ?? base, rest.join('-')]
}
