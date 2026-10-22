import type { LeaveData } from '../../../shared/ipc/core'
import { cancelPrepare, leaveRoom, saveFile } from '../leave'
import { formatPercent } from '../lib/format'
import { setUi, useApp } from '../store'
import { Modal } from './ui'
import styles from './LeavePrompt.module.css'

/** Leave the room: viewers choose what happens to the downloaded data; the host may end the room. */
export function LeavePrompt(): React.JSX.Element {
  const role = useApp((s) => s.core.session?.role)
  const progress = useApp((s) => s.core.transfer?.progress ?? 0)
  const close = (): void => setUi({ leaveOpen: false })
  const cancel = (
    <button type="button" onClick={close}>
      Cancel
    </button>
  )

  // leave.ts closes the prompt and shows the Room's leaving banner until core is done
  const leave = (data: LeaveData, end = false): void => void leaveRoom(data, { end })

  if (role === 'host') {
    return (
      <Modal title="Leave the room?" onClose={close} footer={cancel}>
        <div className={styles.options}>
          <Option label="Leave for now" onClick={() => leave('keep')}>
            Stop hosting for now. Viewers keep what they downloaded; resume the room from Home to continue.
          </Option>
          <Option label="End room for everyone" danger onClick={() => leave('keep', true)}>
            Everyone is disconnected and the invite stops working.
          </Option>
        </div>
      </Modal>
    )
  }

  const complete = progress >= 1
  return (
    <Modal title="Leave the room?" onClose={close} footer={cancel}>
      <div className={styles.options}>
        <Option label="Save file" disabled={!complete} onClick={() => void saveFile()}>
          {complete
            ? 'Move the finished video into your download folder. This can take a few minutes.'
            : `Only ${formatPercent(progress)} is downloaded, so there is no complete file to save yet.`}
        </Option>
        <Option label="Keep for later" onClick={() => leave('keep')}>
          Keep the downloaded parts so you can resume from Home. Removed after 7 days.
        </Option>
        <Option label="Delete now" danger onClick={() => leave('delete')}>
          Remove everything downloaded for this room.
        </Option>
      </div>
    </Modal>
  )
}

/**
 * The tray's "Leave room…" while preparing. The room exists already, and leaving it now ends it (HostPrepare's
 * Cancel, session.cancelPrepare), so this asks first: the tray item is far from the screen it acts on.
 */
export function StopHostingPrompt(): React.JSX.Element {
  const close = (): void => setUi({ leaveOpen: false })
  return (
    <Modal
      title="Stop hosting?"
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Keep preparing
          </button>
          {/* leave.ts closes the prompt; HostPrepare shows "Cancelling…" until core is done */}
          <button type="button" className="danger" onClick={() => void cancelPrepare()}>
            Stop hosting
          </button>
        </>
      }
    >
      <p>Preparing stops and the room ends: anyone who already joined is disconnected, and the invite stops working.</p>
    </Modal>
  )
}

function Option(props: {
  label: string
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={styles.option}>
      <button
        type="button"
        className={props.danger ? 'danger' : undefined}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.label}
      </button>
      <p className="muted">{props.children}</p>
    </div>
  )
}
