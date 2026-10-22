import type { MpvInfo } from '../../../shared/ipc/control'
import type { Result } from '../../../shared/result'

const CANDIDATE_TEXT = { ok: 'usable', tooOld: 'too old', unusable: 'cannot be started' } as const

/** The outcome of `recheckMpv()` in one line: "mpv 0.41.0 found" or "mpv not usable: …". */
export function mpvCheckText(r: Result<MpvInfo>): { ok: boolean; text: string } {
  if (!r.ok) return { ok: false, text: `mpv not usable: ${r.message}` }
  const info = r.value
  const status = info.status ?? (info.path !== null ? 'ok' : 'missing')
  if (status === 'ok') return { ok: true, text: info.version ? `mpv ${info.version} found` : 'mpv found' }
  // tried[0] is the first candidate looked at: the configured path when one is set
  const first = info.tried?.[0]
  let reason: string
  if (first?.detail) reason = first.detail
  else if (first) {
    const version = first.version ? ` ${first.version}` : ''
    reason = `${first.path}${version} ${CANDIDATE_TEXT[first.status]}`
  } else if (status === 'tooOld') reason = `version ${info.version ?? '?'} is too old`
  else reason = 'not found'
  return { ok: false, text: `mpv not usable: ${reason}` }
}
