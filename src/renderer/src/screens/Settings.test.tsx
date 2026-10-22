import { afterEach, describe, expect, it } from 'vitest'
import { type Mounted, byLabel, byRole, click, mountApp, queryByRole, text, typeInto } from '../test/harness'

describe('Settings overlay', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  const open = async (): Promise<HTMLElement> => {
    if (!m) throw new Error('not mounted')
    await click(byRole(m.container, 'button', 'Settings'))
    return byRole(m.container, 'dialog', 'Settings')
  }

  it('applies the theme at once', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await click(byRole(dialog, 'radio', 'Dark'))
    expect(m.fake.settings.theme).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#121317')
    expect(document.documentElement.style.getPropertyValue('--peer-0')).toBe('#ff8a4c')
  })

  it('validates fields and saves only after they are fixed', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await typeInto(byLabel(dialog, 'UDP port'), '80')
    await typeInto(byLabel(dialog, 'Relay key'), 'not-a-key')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(text(dialog)).toContain('UDP port must be between 1024 and 65535')
    expect(byLabel(dialog, 'Relay key').getAttribute('aria-invalid')).toBe('true')
    expect(m.fake.appCalls.filter((c) => c.method === 'setSettings')).toEqual([])

    await typeInto(byLabel(dialog, 'UDP port'), '49737')
    await typeInto(byLabel(dialog, 'Relay key'), 'AB'.repeat(32))
    await typeInto(byLabel(dialog, 'Display name'), 'Robin')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.settings).toMatchObject({ udpPort: 49737, relayKey: 'ab'.repeat(32), displayName: 'Robin' })
    expect(queryByRole(m.container, 'dialog', 'Settings')).toBeNull()
  })

  it('warns when behind after the seconds typed, and not at all when switched off', async () => {
    m = await mountApp('home')
    let dialog = await open()
    const seconds = (): HTMLInputElement => byLabel(dialog, 'Seconds behind before warning') as HTMLInputElement
    expect(seconds().disabled).toBe(false)
    expect(seconds().value).toBe('1')
    await typeInto(seconds(), '0.2')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(text(dialog)).toContain('Seconds must be between 0.5 and 30.')
    expect(m.fake.appCalls.filter((c) => c.method === 'setSettings')).toEqual([])
    // switched off, the field's error no longer applies (off saves 0 whatever it holds): it goes, footer and all
    const warn = byRole(dialog, 'switch', 'Warn when I fall behind')
    await click(warn)
    expect(text(dialog)).not.toContain('Seconds must be between')
    expect(text(dialog)).not.toContain('Fix the highlighted fields.')
    expect(seconds().getAttribute('aria-invalid')).toBeNull()
    await click(warn)
    expect(seconds().disabled).toBe(false)
    await typeInto(seconds(), '2')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.settings.desyncWarnMs).toBe(2000)

    dialog = await open()
    expect(seconds().value).toBe('2')
    await click(byRole(dialog, 'switch', 'Warn when I fall behind'))
    expect(seconds().disabled).toBe(true)
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.settings.desyncWarnMs).toBe(0)
  })

  it('limits downloads for watching, apart from the upload limit', async () => {
    m = await mountApp('home')
    const dialog = await open()
    const download = byLabel(dialog, 'Download limit (KB/s)')
    expect(text(dialog)).toContain('Watching only. Empty for no limit.')
    expect(text(dialog)).toContain('Hosting and watching. Empty for no limit.')
    await typeInto(download, '0')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(text(dialog)).toContain('Download limit must be between 1 and 10000000.')
    expect(download.getAttribute('aria-invalid')).toBe('true')
    expect(m.fake.appCalls.filter((c) => c.method === 'setSettings')).toEqual([])
    await typeInto(download, '500')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.appCalls.filter((c) => c.method === 'setSettings').map((c) => c.params)).toEqual([
      [{ downloadLimitKBps: 500 }],
    ])
    expect(m.fake.settings).toMatchObject({ downloadLimitKBps: 500, uploadLimitKBps: null })
  })

  it('locates mpv and re-checks it on save', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await click(byRole(dialog, 'button', 'Locate mpv…'))
    expect(text(dialog)).toContain('/opt/mpv/bin/mpv')
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.settings.mpvPath).toBe('/opt/mpv/bin/mpv')
    expect(m.fake.appCalls.some((c) => c.method === 'recheckMpv')).toBe(true)
  })

  it('reports the mpv found after saving a new mpv path', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await click(byRole(dialog, 'button', 'Locate mpv…'))
    await click(byRole(dialog, 'button', /^Save$/))
    expect(queryByRole(m.container, 'dialog', 'Settings')).toBeNull()
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain('Settings saved. mpv 0.41.0 found.')
  })

  it('stays open and says why when the new mpv is not usable', async () => {
    m = await mountApp('home')
    m.fake.bridge.app.pickMpv = () => Promise.resolve('/home/alex/broken/mpv')
    const dialog = await open()
    await click(byRole(dialog, 'button', 'Locate mpv…'))
    await click(byRole(dialog, 'button', /^Save$/))
    expect(m.fake.settings.mpvPath).toBe('/home/alex/broken/mpv')
    expect(byRole(m.container, 'dialog', 'Settings')).toBeTruthy()
    expect(text(dialog.querySelector('[data-testid="mpv-status"]') as Element)).toBe('⚠ mpv not usable: not executable')
    // nothing else changed: Save now just closes
    await click(byRole(dialog, 'button', /^Save$/))
    expect(queryByRole(m.container, 'dialog', 'Settings')).toBeNull()
  })

  it('Escape closes without saving', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await typeInto(byLabel(dialog, 'Display name'), 'Nobody')
    const { key } = await import('../test/harness')
    await key(dialog, 'Escape')
    expect(queryByRole(m.container, 'dialog', 'Settings')).toBeNull()
    expect(m.fake.settings.displayName).toBe('Alex')
  })

  it('copies diagnostics with core data attached', async () => {
    m = await mountApp('home')
    const dialog = await open()
    await click(byRole(dialog, 'button', 'Copy diagnostics'))
    const call = m.fake.appCalls.find((c) => c.method === 'copyDiagnostics')
    expect((call?.params as unknown[])[0]).toMatchObject({ uptimeS: 42 })
  })
})

describe('MpvSetup', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('shows Linux commands with the user distro highlighted, and locates mpv', async () => {
    m = await mountApp('mpv-missing')
    expect(text(m.container)).toContain('flatpak install flathub io.mpv.Mpv')
    expect(text(m.container.querySelector('[data-testid="recipe-arch"]') ?? undefined)).toContain('Your system')
    expect(text(m.container.querySelector('[data-testid="recipe-debian"]') ?? undefined)).not.toContain('Your system')
    await click(byRole(m.container, 'button', 'Locate mpv…'))
    expect(m.fake.settings.mpvPath).toBe('/opt/mpv/bin/mpv')
    // the fake reports mpv found, so the app leaves MpvSetup
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('home')
  })

  it('on Windows explains that mpv is bundled', async () => {
    m = await mountApp('mpv-missing', { info: { platform: 'win32', distro: null } })
    expect(text(m.container)).toContain('ships its own mpv on Windows')
    expect(text(m.container)).not.toContain('pacman')
  })
})
