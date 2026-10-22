import type { CoreMethod, IntentRejection, ParamsOf, PlaybackIntent, ResultOf } from '../../shared/ipc/core'
import { CORE_ERRORS } from '../../shared/ipc/core'
import type { Result } from '../../shared/result'
import { wt } from './bridge'
import { playhead, pushToast, useApp } from './store'

/** Core request that reports failures as a toast unless `quiet`. */
export async function call<M extends CoreMethod>(
  method: M,
  params: ParamsOf<M>,
  opts: { quiet?: boolean } = {},
): Promise<Result<ResultOf<M>>> {
  const r = await wt().core.request(method, params)
  if (!r.ok && !opts.quiet) pushToast({ level: 'error', message: describeError(r), code: `rpc:${method}` })
  return r
}

export function describeError(r: { code: string; message: string }): string {
  if (r.code === CORE_ERRORS.notImplemented) return `Not available yet (${r.message})`
  if (r.code === CORE_ERRORS.coreRestarted) return 'The background process restarted. Try again.'
  return r.message
}

const REJECTION_TEXT: Record<IntentRejection, string> = {
  'perm-playpause': 'Only the host can play or pause right now.',
  'perm-seek': 'Only the host can seek right now.',
  superseded: 'Someone else changed playback at the same moment.',
  stale: 'Playback changed before your action arrived.',
  'not-ready': 'Playback is not ready yet.',
  timeout: 'The host did not answer in time.',
}

/** Sends a playback intent; a permission denial becomes a toast with an "Ask host" action. */
export async function sendIntent(intent: PlaybackIntent): Promise<boolean> {
  const r = await call('playback.intent', intent)
  if (!r.ok) return false
  if (r.value.accepted) return true
  denied(intent, r.value.reason ?? 'not-ready')
  return false
}

/** Explains a rejected (or locally disallowed) intent; permission denials offer to ask the host. */
export function denied(intent: PlaybackIntent, reason: IntentRejection): void {
  const isPerm = reason === 'perm-playpause' || reason === 'perm-seek'
  const ask = askFor(intent)
  pushToast({
    level: isPerm ? 'warn' : 'info',
    message: REJECTION_TEXT[reason],
    code: 'intent',
    ...(isPerm ? { action: { label: 'Ask host', run: () => void askHost(ask) } } : {}),
  })
}

export type AskHost = ParamsOf<'sync.request'>

export function askFor(intent: PlaybackIntent): AskHost {
  const paused = useApp.getState().core.playback?.paused ?? true
  switch (intent.kind) {
    case 'play':
    case 'pause':
      return { kind: intent.kind }
    case 'toggle':
      return { kind: paused ? 'play' : 'pause' }
    case 'seek':
      return { kind: 'seek', posS: intent.posS }
    case 'seekRel':
      return { kind: 'seek', posS: Math.max(0, (playhead.position(performance.now()) ?? 0) + intent.deltaS) }
  }
}

export async function askHost(ask: AskHost): Promise<void> {
  const r = await call('sync.request', ask)
  if (r.ok) pushToast({ level: 'info', message: 'Asked the host.', code: 'intent' })
}
