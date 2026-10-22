import { useState } from 'react'
import { LIMIT_MAX_KBPS } from '../../../shared/limits'
import { wt } from '../bridge'
import { limitKBps } from '../lib/settings-form'
import { useApp } from '../store'

/**
 * A transfer limit edited in the Room (the host's upload limit, the viewer's two): KB/s, empty for none. Blur or
 * Enter saves it to Settings, which core applies at once, so Settings and the Room show one value.
 */
export function LimitField({
  id,
  label,
  setting,
  hint,
}: {
  id: string
  label: string
  setting: 'uploadLimitKBps' | 'downloadLimitKBps'
  hint?: string
}): React.JSX.Element {
  const saved = useApp((s) => s.settings?.[setting] ?? null)
  // null follows the saved value; a string is an edit in progress
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = draft ?? (saved === null ? '' : String(saved))

  const commit = async (): Promise<void> => {
    if (draft === null) return
    // Settings' own check, so a value saved here never fails a later Save there
    const parsed = limitKBps(draft, label)
    if (!parsed.ok) {
      setError(`Use a whole number of KB/s up to ${LIMIT_MAX_KBPS}, or leave empty for no limit.`)
      return
    }
    const n = parsed.value
    setError(null)
    setDraft(null)
    if (n === saved) return
    const r = await wt().app.setSettings({ [setting]: n })
    if (!r.ok) setError(r.message)
  }

  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ')
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="number"
          min={1}
          style={{ width: 110 }}
          placeholder="No limit"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === 'Enter' && void commit()}
        />
      </div>
      {hint && (
        <p id={`${id}-hint`} className="muted" style={{ margin: 0, fontSize: 12 }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="error-text" role="alert" style={{ margin: 0, fontSize: 12 }}>
          {error}
        </p>
      )}
    </div>
  )
}
