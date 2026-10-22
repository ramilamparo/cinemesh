// electron-builder afterPack hook (electron-builder.yml: afterPack). It runs once the app is assembled in appOutDir,
// before signing and before the installers are built.
//
// Windows and macOS packages must contain the mpv that scripts/fetch-mpv.mjs puts in vendor/mpv/<os>-<arch>/.
// electron-builder only logs a warning when an extraResources folder is missing, which would ship an app that cannot
// play anything, so this hook fails the build instead. WT_ALLOW_MISSING_MPV=1 lets a local test build through.
// Every package must also carry resources/licenses (mpv's GPL text and source offer, third-party notices).
//
// The nested mpv.app needs no signing step here: electron-builder's macOS signing (@electron/osx-sign) walks the whole
// of Contents/, Contents/Resources/mpv/mpv.app included, signs every binary and every nested .app deepest first with
// the configured identity ('-', ad hoc) and --force, then runs codesign --verify --deep --strict on the app.
//
// electron-builder.yml keeps only the N-API prebuilds of the OS electron-builder runs on (${platform}); this hook
// fails a build for another OS (a cross-build), which would otherwise ship addons that cannot load.
import console from 'node:console'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// builder-util's Arch enum
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
// Addons the core loads at startup (src/core/selftest.ts checks the same set in the packaged app).
const REQUIRED_ADDONS = ['sodium-native', 'udx-native']

/** Names of every prebuilds/<target>/ folder under dir. */
function prebuildTargets(dir, out = new Set()) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'prebuilds') {
      for (const t of readdirSync(join(dir, ent.name), { withFileTypes: true })) if (t.isDirectory()) out.add(t.name)
    } else prebuildTargets(join(dir, ent.name), out)
  }
  return out
}

function checkPrebuilds(resources, platform, arch) {
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
  if (!existsSync(unpacked)) throw new Error(`afterPack: ${unpacked} is missing (asarUnpack)`)
  const os = platform === 'mas' ? 'darwin' : platform
  const foreign = [...prebuildTargets(unpacked)].filter((t) => !t.startsWith(`${os}-`))
  if (foreign.length) {
    throw new Error(
      `afterPack: prebuilds for another OS were packaged (${foreign.join(', ')}). electron-builder.yml keeps the ` +
        `prebuilds of the OS it runs on, so build ${os} packages on ${os}.`,
    )
  }
  for (const name of REQUIRED_ADDONS) {
    const dirs = existsSync(join(unpacked, name, 'prebuilds')) ? readdirSync(join(unpacked, name, 'prebuilds')) : []
    const want =
      arch === 'universal' ? dirs.filter((d) => d.startsWith(`${os}-`)) : dirs.filter((d) => d === `${os}-${arch}`)
    if (!want.length)
      throw new Error(`afterPack: ${name} has no ${os}-${arch} prebuild (found: ${dirs.join(', ') || 'none'})`)
  }
}

export default function afterPack(context) {
  const platform = context.electronPlatformName
  const resources =
    platform === 'darwin' || platform === 'mas'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')

  const notice = join(resources, 'licenses', 'THIRD-PARTY.md')
  if (!existsSync(notice)) throw new Error(`afterPack: ${notice} is missing (electron-builder.yml extraResources)`)
  checkPrebuilds(resources, platform, ARCH[context.arch] ?? String(context.arch))

  if (platform !== 'darwin' && platform !== 'win32') return
  const os = platform === 'darwin' ? 'mac' : 'win'
  const mpv =
    platform === 'darwin'
      ? join(resources, 'mpv', 'mpv.app', 'Contents', 'MacOS', 'mpv')
      : join(resources, 'mpv', 'mpv.exe')
  if (existsSync(mpv)) {
    if (!existsSync(join(resources, 'licenses', 'mpv', 'SOURCE-OFFER.md'))) {
      throw new Error('afterPack: mpv is bundled but resources/licenses/mpv/SOURCE-OFFER.md is not')
    }
    console.log(`  • bundled mpv  file=${mpv}`)
    return
  }
  const fetch = `node scripts/fetch-mpv.mjs --platform ${os}-${ARCH[context.arch] ?? String(context.arch)}`
  if (process.env.WT_ALLOW_MISSING_MPV === '1') {
    console.warn(`  • WARNING: no bundled mpv (WT_ALLOW_MISSING_MPV=1)  expected=${mpv}`)
    return
  }
  throw new Error(
    `afterPack: bundled mpv is missing: ${mpv}\nRun \`${fetch}\` first (WT_ALLOW_MISSING_MPV=1 skips this).`,
  )
}
