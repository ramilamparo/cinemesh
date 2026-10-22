import { useEffect, useId, useRef, type ReactNode } from 'react'
import styles from './ui.module.css'

/** On/off control with the state spelled out, not only shown by colour. */
export function Switch(props: {
  checked: boolean
  onChange: (on: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}): React.JSX.Element {
  const descId = useId()
  return (
    <div className={styles.switchRow}>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-describedby={props.description ? descId : undefined}
        disabled={props.disabled}
        className={styles.switch}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className={styles.knob} aria-hidden="true" />
        <span className={styles.switchState} aria-hidden="true">
          {props.checked ? 'On' : 'Off'}
        </span>
        <span className={styles.switchLabel}>{props.label}</span>
      </button>
      {props.description && (
        <p id={descId} className={styles.hint}>
          {props.description}
        </p>
      )}
    </div>
  )
}

export function Field(props: {
  label: string
  hint?: string
  error?: string | undefined
  children: (ids: FieldIds) => ReactNode
}): React.JSX.Element {
  const id = useId()
  const ids: FieldIds = {
    id: `${id}-input`,
    'aria-describedby':
      [props.hint ? `${id}-hint` : null, props.error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined,
    'aria-invalid': props.error ? true : undefined,
  }
  return (
    <div className={styles.field}>
      <label htmlFor={ids.id} className={styles.label}>
        {props.label}
      </label>
      {props.children(ids)}
      {props.hint && (
        <p id={`${id}-hint`} className={styles.hint}>
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={`${id}-err`} className={styles.error} role="alert">
          {props.error}
        </p>
      )}
    </div>
  )
}

export interface FieldIds {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

export function Segmented<T extends string>(props: {
  label: string
  value: T | null
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <div className={styles.segmentedRow}>
      <span id={id} className={styles.label}>
        {props.label}
      </span>
      <div className={styles.segmented} role="radiogroup" aria-labelledby={id}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            disabled={props.disabled}
            className={props.value === o.value ? styles.selected : undefined}
            onClick={() => props.onChange(o.value)}
          >
            {props.value === o.value && <span aria-hidden="true">✓ </span>}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Modal dialog: focuses its first control, keeps Tab inside, closes on Escape. */
export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  footer?: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { onClose } = props

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => previous?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={props.wide ? `${styles.dialog} ${styles.wide}` : styles.dialog}
        onKeyDown={onKeyDown}
      >
        <header className={styles.dialogHeader}>
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className={styles.dialogBody}>{props.children}</div>
        {props.footer && <footer className={styles.dialogFooter}>{props.footer}</footer>}
      </div>
    </div>
  )
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ProgressBar(props: { value: number; label: string }): React.JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100)
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div style={{ width: `${String(pct)}%` }} />
    </div>
  )
}
