import { useState } from 'react'
import { THEME_MODES, type ThemeMode } from '../../../shared/theme-tokens'
import type { Settings } from '../../../shared/settings'
import { wt } from '../bridge'
import { Field, Modal, Segmented, Switch } from '../components/ui'
import { mpvCheckText } from '../lib/mpv-check'
import { type FormErrors, type SettingsForm, formFromSettings, validateSettingsForm } from '../lib/settings-form'
import { call } from '../rpc'
import { pushToast, setUi, useApp } from '../store'
import styles from './Settings.module.css'

const THEME_OPTIONS = THEME_MODES.map((value) => ({
  value,
  label: ({ system: 'System', light: 'Light', dark: 'Dark' } as const)[value],
}))

export function SettingsOverlay(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const close = (): void => setUi({ settingsOpen: false })
  return (
    <Modal title="Settings" onClose={close} wide>
      {settings ? <SettingsBody settings={settings} onClose={close} /> : <p>Loading…</p>}
    </Modal>
  )
}

function SettingsBody({ settings, onClose }: { settings: Settings; onClose: () => void }): React.JSX.Element {
  const info = useApp((s) => s.info)
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(settings))
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [mpvStatus, setMpvStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]): void => {
    if (key === 'mpvPath') setMpvStatus(null)
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }

  const save = async (): Promise<void> => {
    const v = validateSettingsForm(form, settings)
    if (!v.ok) {
      setErrors(v.errors)
      return
    }
    if (Object.keys(v.patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    const r = await wt().app.setSettings(v.patch)
    setSaving(false)
    if (!r.ok) {
      setErrors({ form: r.message })
      return
    }
    const api = wt().app
    if (v.patch.mpvPath !== undefined && api.recheckMpv) {
      const mpv = mpvCheckText(await api.recheckMpv())
      if (!mpv.ok) {
        // stay open so the path can be fixed; everything else is already saved
        setMpvStatus(mpv)
        return
      }
      pushToast({ level: 'info', message: `Settings saved. ${mpv.text}.`, code: 'settings' })
    } else {
      pushToast({ level: 'info', message: 'Settings saved.', code: 'settings' })
    }
    onClose()
  }

  const pickDir = async (): Promise<void> => {
    const dir = await wt().app.pickFolder(form.downloadDir ?? undefined)
    if (dir) set('downloadDir', dir)
  }
  const pickMpv = async (): Promise<void> => {
    const path = await wt().app.pickMpv()
    if (path) set('mpvPath', path)
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      noValidate
    >
      <section className={styles.section} aria-labelledby="set-appearance">
        <h3 id="set-appearance">Appearance and identity</h3>
        <Segmented
          label="Theme"
          value={settings.theme}
          options={THEME_OPTIONS}
          onChange={(t: ThemeMode) => void wt().app.setSettings({ theme: t })}
        />
        <Field label="Display name" hint="What friends see in the room." error={errors.displayName}>
          {(ids) => (
            <input
              {...ids}
              type="text"
              maxLength={32}
              value={form.displayName}
              onChange={(e) => set('displayName', e.target.value)}
            />
          )}
        </Field>
      </section>

      <section className={styles.section} aria-labelledby="set-storage">
        <h3 id="set-storage">Storage</h3>
        <PathRow
          label="Download folder"
          value={form.downloadDir}
          fallback="Downloads/Watch Together"
          onPick={() => void pickDir()}
          onReset={() => set('downloadDir', null)}
        />
        <Field
          label="Cache limit (GB)"
          hint="Kept downloads from earlier rooms are removed above this size or after 7 days."
          error={errors.cacheCapGB}
        >
          {(ids) => (
            <input
              {...ids}
              type="number"
              min={1}
              value={form.cacheCapGB}
              onChange={(e) => set('cacheCapGB', e.target.value)}
            />
          )}
        </Field>
      </section>

      <section className={styles.section} aria-labelledby="set-player">
        <h3 id="set-player">Player</h3>
        <PathRow
          label="mpv program"
          value={form.mpvPath}
          fallback={info?.platform === 'linux' ? 'Found automatically' : 'Bundled with the app'}
          onPick={() => void pickMpv()}
          onReset={() => set('mpvPath', null)}
          pickLabel="Locate mpv…"
        />
        {mpvStatus && (
          <p className="error-text" role="alert" data-testid="mpv-status" style={{ margin: 0, fontSize: 12 }}>
            <span aria-hidden="true">⚠ </span>
            {mpvStatus.text}
          </p>
        )}
        <Field label="Hardware decoding">
          {(ids) => (
            <select {...ids} value={form.hwdec} onChange={(e) => set('hwdec', e.target.value as Settings['hwdec'])}>
              <option value="auto-safe">Automatic (recommended)</option>
              <option value="no">Off (software decoding)</option>
            </select>
          )}
        </Field>
        <div className={styles.pair}>
          <Field label="Preferred audio languages" hint="Comma separated, e.g. en, ja" error={errors.alang}>
            {(ids) => <input {...ids} type="text" value={form.alang} onChange={(e) => set('alang', e.target.value)} />}
          </Field>
          <Field label="Preferred subtitle languages" hint="Comma separated, e.g. en" error={errors.slang}>
            {(ids) => <input {...ids} type="text" value={form.slang} onChange={(e) => set('slang', e.target.value)} />}
          </Field>
        </div>
        <Switch
          label="Speed nudges"
          description="Briefly play up to 5 % faster or slower to stay in sync, instead of jumping."
          checked={form.speedNudge}
          onChange={(on) => set('speedNudge', on)}
        />
        <Switch
          label="Always show the download strip in the player"
          checked={form.oscPersistentStrip}
          onChange={(on) => set('oscPersistentStrip', on)}
        />
        {info?.platform === 'darwin' && (
          <Switch
            label="Experimental HDR output (macOS)"
            description="Uses EDR; may not work on every display."
            checked={form.macHdrExperimental}
            onChange={(on) => set('macHdrExperimental', on)}
          />
        )}
      </section>

      <section className={styles.section} aria-labelledby="set-network">
        <h3 id="set-network">Network</h3>
        <Field
          label="Relay key"
          hint="From a relay you run (packages/relay). 64 hex or 52 z-base-32 characters; leave empty for none."
          error={errors.relayKey}
        >
          {(ids) => (
            <input
              {...ids}
              type="text"
              spellCheck={false}
              value={form.relayKey}
              onChange={(e) => set('relayKey', e.target.value)}
            />
          )}
        </Field>
        <Switch
          label="Always use the relay"
          description="Keep every new connection on the relay instead of switching to a direct one, so friends never see your address. Friends with an open address are still reached directly. Needs a relay key; uses relay bandwidth."
          checked={form.alwaysRelay}
          onChange={(on) => set('alwaysRelay', on)}
        />
        <div className={styles.pair}>
          <Field
            label="UDP port"
            hint="For a port forward on your router; empty picks one. Helps only when the Network test says Consistent; with Random, add a relay. Takes effect in new rooms."
            error={errors.udpPort}
          >
            {(ids) => (
              <input {...ids} type="number" value={form.udpPort} onChange={(e) => set('udpPort', e.target.value)} />
            )}
          </Field>
          <Field label="Upload limit (KB/s)" hint="Empty for no limit." error={errors.uploadLimitKBps}>
            {(ids) => (
              <input
                {...ids}
                type="number"
                value={form.uploadLimitKBps}
                onChange={(e) => set('uploadLimitKBps', e.target.value)}
              />
            )}
          </Field>
          <Field label="Hashing threads" hint="1 to 4." error={errors.hashWorkers}>
            {(ids) => (
              <input
                {...ids}
                type="number"
                min={1}
                max={4}
                value={form.hashWorkers}
                onChange={(e) => set('hashWorkers', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Extra bootstrap nodes" hint="One host:port per line. Advanced." error={errors.bootstrapExtra}>
          {(ids) => (
            <textarea
              {...ids}
              rows={2}
              spellCheck={false}
              value={form.bootstrapExtra}
              onChange={(e) => set('bootstrapExtra', e.target.value)}
            />
          )}
        </Field>
      </section>

      <section className={styles.section} aria-labelledby="set-host">
        <h3 id="set-host">When you host</h3>
        <Switch
          label="Let others play, pause and seek"
          checked={form.hostOthersControl}
          onChange={(on) => set('hostOthersControl', on)}
        />
        <Switch label="Wait for everyone" checked={form.hostWaitForAll} onChange={(on) => set('hostWaitForAll', on)} />
        <Segmented
          label="Start"
          value={form.hostStartMode}
          options={[
            { value: 'buffered', label: 'After buffering' },
            { value: 'play-through', label: 'Immediately' },
          ]}
          onChange={(v) => set('hostStartMode', v)}
        />
        <div className={styles.pair}>
          {form.hostStartMode === 'buffered' && (
            <Field label="Seconds buffered before starting" error={errors.hostStartSeconds}>
              {(ids) => (
                <input
                  {...ids}
                  type="number"
                  min={0}
                  value={form.hostStartSeconds}
                  onChange={(e) => set('hostStartSeconds', e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Room size (including you)" hint="2 to 12." error={errors.hostMaxMembers}>
            {(ids) => (
              <input
                {...ids}
                type="number"
                min={2}
                max={12}
                value={form.hostMaxMembers}
                onChange={(e) => set('hostMaxMembers', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Segmented
          label="New people"
          value={form.hostAdmission}
          options={[
            { value: 'open', label: 'Join freely' },
            { value: 'approve', label: 'Ask me first' },
          ]}
          onChange={(v) => set('hostAdmission', v)}
        />
      </section>

      <Support />

      <footer className={styles.footer}>
        {errors.form && (
          <p className="error-text" role="alert" style={{ margin: 0, marginRight: 'auto' }}>
            {errors.form}
          </p>
        )}
        {Object.values(errors).some(Boolean) && !errors.form && (
          <p className="error-text" role="alert" style={{ margin: 0, marginRight: 'auto' }}>
            Fix the highlighted fields.
          </p>
        )}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          Save
        </button>
      </footer>
    </form>
  )
}

function PathRow(props: {
  label: string
  value: string | null
  fallback: string
  onPick: () => void
  onReset: () => void
  pickLabel?: string
}): React.JSX.Element {
  return (
    <div className={styles.pathRow}>
      <span className={styles.pathLabel}>{props.label}</span>
      <code className={styles.path} title={props.value ?? undefined}>
        {props.value ?? <span className="muted">{props.fallback}</span>}
      </code>
      <div className="row">
        <button type="button" className="small" onClick={props.onPick}>
          {props.pickLabel ?? 'Change…'}
        </button>
        {props.value !== null && (
          <button type="button" className="small" onClick={props.onReset}>
            Use default
          </button>
        )}
      </div>
    </div>
  )
}

function Support(): React.JSX.Element {
  const isAppImage = useApp((s) => s.info?.isAppImage ?? false)
  const copyDiagnostics = async (): Promise<void> => {
    const core = await call('diagnostics.get', {}, { quiet: true })
    const r = await wt().app.copyDiagnostics(core.ok ? core.value : null)
    pushToast(
      r.ok
        ? { level: 'info', message: 'Diagnostics copied. Paste them into your bug report.', code: 'diag' }
        : { level: 'error', message: r.message, code: 'diag' },
    )
  }
  const register = async (): Promise<void> => {
    const r = await wt().app.registerLinuxDeepLinks()
    pushToast(
      r.ok
        ? { level: 'info', message: 'Invite links now open Watch Together.', code: 'links' }
        : { level: 'error', message: r.message, code: 'links' },
    )
  }
  return (
    <section className={styles.section} aria-labelledby="set-support">
      <h3 id="set-support">Help and troubleshooting</h3>
      <div className="row">
        <button type="button" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </button>
        <button type="button" onClick={() => void wt().app.openLogsFolder()}>
          Open logs folder
        </button>
        {isAppImage && (
          <button type="button" onClick={() => void register()}>
            Register invite links
          </button>
        )}
      </div>
      {isAppImage && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          AppImages are not installed, so the system does not know they open watchtogether:// links until you register.
        </p>
      )}
    </section>
  )
}
