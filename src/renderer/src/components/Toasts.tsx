import { useEffect } from 'react'
import type { CoreMethod } from '../../../shared/ipc/core'
import { call } from '../rpc'
import { finishExport } from '../saves'
import { type Toast, type ToastAction, dismissToast, useApp } from '../store'
import styles from './Toasts.module.css'

const LIFETIME_MS: Record<Toast['level'], number | null> = { info: 6000, warn: 10_000, error: null }
const LEVEL_TEXT: Record<Toast['level'], string> = { info: 'Info', warn: 'Warning', error: 'Error' }
const LEVEL_ICON: Record<Toast['level'], string> = { info: 'ℹ', warn: '⚠', error: '⛔' }

export function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  return (
    <section className={styles.region} aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </section>
  )
}

function ToastItem({ toast }: { toast: Toast }): React.JSX.Element {
  useEffect(() => {
    const ms = toast.sticky ? null : LIFETIME_MS[toast.level]
    if (ms === null) return
    const timer = setTimeout(() => dismissToast(toast.id), ms)
    return () => clearTimeout(timer)
  }, [toast])
  return (
    <div className={styles.toast} data-level={toast.level} role={toast.level === 'error' ? 'alert' : 'status'}>
      <span className={styles.icon} aria-hidden="true">
        {LEVEL_ICON[toast.level]}
      </span>
      <span className="visually-hidden">{LEVEL_TEXT[toast.level]}: </span>
      <span className={styles.message}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="small"
          onClick={() => {
            if (toast.action) runAction(toast.action)
            dismissToast(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  )
}

function runAction(action: ToastAction): void {
  if ('run' in action) action.run()
  else runRequest(action.request, action.params)
}

/**
 * A notice's button is core's request. It runs like the UI's own requests: a failure shows the usual error toast, and
 * a cut-off save's Finish saving (transfer.export-waiting) gets the outcome handling of Home's button (saves.ts).
 */
function runRequest(request: CoreMethod, params: unknown): void {
  const p = typeof params === 'object' && params !== null ? (params as { roomId?: unknown; giveUp?: unknown }) : {}
  if (request === 'transfer.finishExport' && typeof p.roomId === 'string') {
    void finishExport(p.roomId, p.giveUp === true)
    return
  }
  // core named the request itself; its params are opaque to the UI
  void call(request, params as never)
}
