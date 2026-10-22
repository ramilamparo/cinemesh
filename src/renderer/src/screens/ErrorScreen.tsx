import { leaveRoom } from '../leave'
import { isLeaving, useApp } from '../store'
import styles from './Screens.module.css'

export function ErrorScreen(): React.JSX.Element {
  const error = useApp((s) => s.core.session?.error)
  // Back to Home runs session.leave: this screen stays up (route.ts) until core is back at idle
  const leaving = useApp(isLeaving)
  return (
    <div className={styles.screen}>
      <section className={`card stack ${styles.centered}`} role="alert">
        <h1>Something went wrong</h1>
        <p>{error?.message ?? 'The session stopped unexpectedly.'}</p>
        {error?.code && (
          <p className="muted">
            Code: <code>{error.code}</code>
          </p>
        )}
        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" className="primary" disabled={leaving} onClick={() => void leaveRoom('keep')}>
            Back to Home
          </button>
        </div>
      </section>
    </div>
  )
}
