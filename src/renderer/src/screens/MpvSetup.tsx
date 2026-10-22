import { useState } from 'react'
import { wt } from '../bridge'
import { call } from '../rpc'
import { pushToast, setUi, useApp } from '../store'
import styles from './Screens.module.css'

export const MIN_MPV = '0.39'

interface Recipe {
  id: string
  /** os-release IDs (and ID_LIKE values) this applies to */
  matches: string[]
  label: string
  command: string
  note?: string
}

export const LINUX_RECIPES: Recipe[] = [
  {
    id: 'arch',
    matches: ['arch', 'cachyos', 'endeavouros', 'manjaro'],
    label: 'Arch Linux and derivatives',
    command: 'sudo pacman -S mpv',
  },
  {
    id: 'fedora',
    matches: ['fedora', 'rhel', 'centos'],
    label: 'Fedora (with RPM Fusion)',
    command: 'sudo dnf install mpv',
  },
  {
    id: 'opensuse',
    matches: ['opensuse', 'opensuse-tumbleweed', 'suse'],
    label: 'openSUSE',
    command: 'sudo zypper install mpv',
  },
  {
    id: 'debian',
    matches: ['debian', 'ubuntu', 'linuxmint', 'pop'],
    label: 'Debian, Ubuntu and Mint',
    command: 'sudo apt install mpv',
    note: `Ubuntu 24.04 and Debian 12 ship mpv older than ${MIN_MPV}; use Flatpak there.`,
  },
  {
    id: 'flatpak',
    matches: [],
    label: 'Any distribution (Flatpak)',
    command: 'flatpak install flathub io.mpv.Mpv',
    note: 'Works everywhere and is always recent. Cinemesh finds it automatically.',
  },
]

export function MpvSetup(): React.JSX.Element {
  const player = useApp((s) => s.core.player)
  const info = useApp((s) => s.info)
  const [checking, setChecking] = useState(false)
  const tooOld = player?.status === 'tooOld'
  const linux = (info?.platform ?? 'linux') === 'linux'
  const distro = info?.distro ?? null

  const recheck = async (): Promise<void> => {
    const api = wt().app
    if (!api.recheckMpv) {
      pushToast({ level: 'info', message: 'Restart Cinemesh to look for mpv again.', code: 'mpv' })
      return
    }
    setChecking(true)
    const r = await api.recheckMpv()
    setChecking(false)
    if (!r.ok) pushToast({ level: 'error', message: r.message, code: 'mpv' })
    else if (r.value.path === null) pushToast({ level: 'warn', message: 'mpv was still not found.', code: 'mpv' })
  }
  const locate = async (): Promise<void> => {
    const path = await wt().app.pickMpv()
    if (!path) return
    const r = await wt().app.setSettings({ mpvPath: path })
    if (!r.ok) {
      pushToast({ level: 'error', message: r.message, code: 'mpv' })
      return
    }
    await recheck()
  }
  const copy = async (text: string): Promise<void> => {
    await wt().app.writeClipboard(text)
    pushToast({ level: 'info', message: 'Command copied.', code: 'mpv-copy' })
  }

  return (
    <div className={styles.screen}>
      <header className={styles.screenHeader}>
        <h1>{tooOld ? 'Your mpv is too old' : 'Cinemesh needs mpv'}</h1>
        <p className="muted">
          {tooOld
            ? `Found mpv ${player.version ?? '?'}; version ${MIN_MPV} or newer is needed for synced playback.`
            : 'Videos play in mpv, a free video player that handles every format and HDR.'}
        </p>
      </header>

      {linux ? (
        <section className="card stack" aria-labelledby="mpv-install">
          <h2 id="mpv-install">Install mpv</h2>
          <p className="muted">Run one of these in a terminal, then press Check again.</p>
          <ul className={styles.stages}>
            {LINUX_RECIPES.map((r) => {
              const match = distro !== null && r.matches.includes(distro)
              return (
                <li
                  key={r.id}
                  data-testid={`recipe-${r.id}`}
                  style={{ flexDirection: 'column', alignItems: 'stretch' }}
                >
                  <span>
                    <strong>{r.label}</strong>
                    {match && (
                      <span className="badge" data-tone="ok" style={{ marginLeft: 8 }}>
                        Your system
                      </span>
                    )}
                  </span>
                  <span className="row">
                    <code>{r.command}</code>
                    <button
                      type="button"
                      className="small"
                      aria-label={`Copy: ${r.command}`}
                      onClick={() => void copy(r.command)}
                    >
                      Copy
                    </button>
                  </span>
                  {r.note && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {r.note}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        <section className="card stack" aria-labelledby="mpv-bundled">
          <h2 id="mpv-bundled">mpv is missing from this installation</h2>
          <p>
            Cinemesh ships its own mpv on {info?.platform === 'darwin' ? 'macOS' : 'Windows'}, but it could not be
            started. Reinstalling the app usually fixes this. You can also point to an mpv you installed yourself.
          </p>
        </section>
      )}

      <div className="row">
        <button type="button" className="primary" disabled={checking} onClick={() => void recheck()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <button type="button" onClick={() => void locate()}>
          Locate mpv…
        </button>
        <button type="button" className="link" onClick={() => setUi({ settingsOpen: true })}>
          Settings
        </button>
        <button
          type="button"
          className="link"
          onClick={() =>
            void call('diagnostics.get', {}, { quiet: true }).then((r) =>
              wt().app.copyDiagnostics(r.ok ? r.value : null),
            )
          }
        >
          Copy diagnostics
        </button>
      </div>
    </div>
  )
}
