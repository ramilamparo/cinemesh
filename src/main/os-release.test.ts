import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseOsReleaseId, readDistro } from './os-release.js'

const dir = mkdtempSync(join(tmpdir(), 'wt-osrel-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('os-release', () => {
  it('reads ID, quoted or not, and ignores ID_LIKE and VERSION_ID', () => {
    expect(parseOsReleaseId('NAME="Arch Linux"\nID_LIKE=foo\nID=arch\n')).toBe('arch')
    expect(parseOsReleaseId('VERSION_ID="24.04"\nID="ubuntu"\n')).toBe('ubuntu')
    expect(parseOsReleaseId("ID='opensuse-tumbleweed'")).toBe('opensuse-tumbleweed')
    expect(parseOsReleaseId('ID=Fedora')).toBe('fedora')
    expect(parseOsReleaseId('NAME=x\n')).toBeNull()
    expect(parseOsReleaseId('ID="evil; rm"')).toBeNull()
  })

  it('tries each file in turn and is null off Linux', async () => {
    const file = join(dir, 'os-release')
    writeFileSync(file, 'ID=cachyos\n')
    expect(await readDistro('linux', [join(dir, 'missing'), file])).toBe('cachyos')
    expect(await readDistro('linux', [join(dir, 'missing')])).toBeNull()
    expect(await readDistro('darwin', [file])).toBeNull()
  })
})
