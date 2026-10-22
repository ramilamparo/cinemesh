import { cancelPrepare, leaveRoom } from '../leave'
import { call } from '../rpc'
import { setUi, useApp } from '../store'
import { Modal } from './ui'

/** A deep link arrived while a room is active: confirm before leaving it. */
export function JoinDialog({ link }: { link: string }): React.JSX.Element {
  const phase = useApp((s) => s.core.session?.phase)
  const fileName = useApp((s) => s.core.session?.fileName)
  const close = (): void => setUi({ incomingLink: null })
  const joining = phase === 'connecting' || phase === 'pending-admission' || phase === 'confirm-join'

  const switchRooms = async (): Promise<void> => {
    close()
    // null: a leave was already running (the deep link waits for it instead, hooks.ts)
    const left = phase === 'preparing' ? await cancelPrepare() : await leaveRoom('keep')
    if (!left?.ok) return
    await call('session.join', { invite: link })
  }

  return (
    <Modal
      title="Join another room?"
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Stay here
          </button>
          <button type="button" className="primary" onClick={() => void switchRooms()}>
            {joining ? 'Join the new room' : 'Leave and join'}
          </button>
        </>
      }
    >
      <p>
        You opened an invite while {joining ? 'joining another room' : 'in a room'}
        {fileName ? (
          <>
            {' '}
            (<strong>{fileName}</strong>)
          </>
        ) : null}
        .
      </p>
      <p className="muted">
        {joining
          ? 'The current join will be cancelled.'
          : 'You will leave the current room. Anything downloaded so far is kept, so you can resume it from Home.'}
      </p>
    </Modal>
  )
}
