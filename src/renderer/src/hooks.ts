import { useEffect } from 'react'
import { extractInvite } from '../../shared/invite-link'
import { wt } from './bridge'
import { leaveRoom } from './leave'
import { shortcutFor } from './lib/keyboard'
import { call, sendIntent } from './rpc'
import { isLeaving, setUi, useApp } from './store'

const DUPLICATE_WINDOW_MS = 10_000

/**
 * Deep links arrive pushed (while running) or pending (cold start, renderer reload). Main keeps a pushed link
 * pending too, so it is taken right after handling and the same link is ignored for a few seconds: JoinConfirm
 * must appear exactly once. A link that arrives while a leave runs (core would refuse a second leave, and a join
 * before it is done) waits for that leave to finish; the newest such link wins.
 */
export function useDeepLinks(): void {
  useEffect(() => {
    const api = wt().app
    let last: { link: string; at: number } | null = null
    let deferred: string | null = null
    const handle = (raw: string | null): void => {
      const link = raw ? extractInvite(raw) : null
      if (!link) return
      const now = Date.now()
      if (last?.link === link && now - last.at < DUPLICATE_WINDOW_MS) return
      last = { link, at: now }
      if (isLeaving(useApp.getState())) deferred = link
      else openInvite(link)
    }
    const unsubscribe = useApp.subscribe((s) => {
      if (deferred === null || isLeaving(s)) return
      const link = deferred
      deferred = null
      openInvite(link)
    })
    const off = api.onDeepLink((link) => {
      handle(link)
      void api.takePendingDeepLink().then(handle)
    })
    void api.takePendingDeepLink().then(handle)
    return () => {
      off()
      unsubscribe()
    }
  }, [])
}

/** Join right away when idle; otherwise confirm before leaving the current room. */
export function openInvite(link: string): void {
  const phase = useApp.getState().core.session?.phase
  if (phase === undefined || phase === 'idle' || phase === 'error') {
    void (async () => {
      if (phase === 'error') await leaveRoom('keep', { quiet: true })
      await call('session.join', { invite: link })
    })()
  } else {
    setUi({ incomingLink: link })
  }
}

/** Space toggles, ←/→ seek ±5 s, unless focus is in a control that uses the key or a dialog is open. */
export function usePlaybackKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat) return
      const shortcut = shortcutFor(e)
      if (!shortcut) return
      e.preventDefault()
      void sendIntent(shortcut)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}
