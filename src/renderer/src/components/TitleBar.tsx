import { setUi, useApp } from '../store'
import styles from './TitleBar.module.css'

/** Draggable header. Windows draws its own buttons in a title-bar overlay on the right, macOS on the left. */
export function TitleBar(): React.JSX.Element {
  const settingsOpen = useApp((s) => s.ui.settingsOpen)
  return (
    <header className={styles.bar}>
      <span className={styles.title}>Cinemesh</span>
      <button
        type="button"
        className={styles.action}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => setUi({ settingsOpen: true })}
      >
        <span aria-hidden="true">⚙</span> Settings
      </button>
    </header>
  )
}
