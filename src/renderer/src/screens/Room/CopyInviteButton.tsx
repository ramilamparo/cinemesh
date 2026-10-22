import { wt } from '../../bridge'
import { call } from '../../rpc'
import { pushToast } from '../../store'

/** Copies the full invite text block (link plus a line on how to get the app). */
export function CopyInviteButton({ primary = false }: { primary?: boolean }): React.JSX.Element {
  const copy = async (): Promise<void> => {
    const r = await call('room.invite', {})
    if (!r.ok) return
    await wt().app.writeClipboard(r.value.text)
    pushToast({ level: 'info', message: 'Invite copied. Paste it to your friends.', code: 'invite' })
  }
  return (
    <button type="button" className={primary ? 'primary' : undefined} onClick={() => void copy()}>
      <span aria-hidden="true">🔗</span> Copy invite
    </button>
  )
}
