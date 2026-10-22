import { useEffect } from 'react'
import { JoinDialog } from './components/JoinDialog'
import { LeavePrompt, StopHostingPrompt } from './components/LeavePrompt'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { useDeepLinks, usePlaybackKeys } from './hooks'
import { applyThemeToDocument } from './lib/theme'
import { type Screen, selectScreen } from './route'
import { ErrorScreen } from './screens/ErrorScreen'
import { Home } from './screens/Home'
import { HostPrepare } from './screens/HostPrepare'
import { JoinConfirm } from './screens/JoinConfirm'
import { MpvSetup } from './screens/MpvSetup'
import { Room } from './screens/Room/Room'
import { SettingsOverlay } from './screens/Settings'
import { isLeaving, leavePromptFor, useApp } from './store'
import styles from './App.module.css'

const SCREENS: Record<Screen, () => React.JSX.Element> = {
  'mpv-setup': MpvSetup,
  home: Home,
  'host-prepare': HostPrepare,
  join: JoinConfirm,
  room: Room,
  error: ErrorScreen,
}

export function App(): React.JSX.Element {
  const platform = useApp((s) => s.info?.platform ?? null)
  const screen = useApp((s) => selectScreen(s.core, s.leavingFrom))
  const theme = useApp((s) => s.theme)
  const { settingsOpen, leaveOpen, incomingLink } = useApp((s) => s.ui)
  const leaving = useApp(isLeaving)
  // none while a leave runs; the store closes a prompt whose session state moved on
  const prompt = useApp((s) => (s.ui.leaveOpen ? leavePromptFor(s) : null))
  const modalOpen = settingsOpen || leaveOpen || incomingLink !== null

  useEffect(() => {
    if (theme) applyThemeToDocument(theme)
  }, [theme])
  useDeepLinks()
  usePlaybackKeys(screen === 'room' && !modalOpen && !leaving)

  const Current = SCREENS[screen]
  return (
    <div className={styles.app} data-platform={platform ?? undefined} data-screen={screen}>
      <TitleBar />
      <main className={styles.main} aria-label={screen === 'room' ? 'Room' : undefined}>
        <Current />
      </main>
      <Toasts />
      {settingsOpen && <SettingsOverlay />}
      {prompt === 'room' && <LeavePrompt />}
      {prompt === 'prepare' && <StopHostingPrompt />}
      {incomingLink !== null && <JoinDialog link={incomingLink} />}
    </div>
  )
}
