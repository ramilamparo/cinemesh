// An AppImage runtime points LD_LIBRARY_PATH/LD_PRELOAD at its bundled libraries; a system or Flatpak
// mpv started with them can load the wrong libstdc++/libva and crash at startup.
const APPIMAGE_VARS = ['LD_LIBRARY_PATH', 'LD_PRELOAD'] as const

export function mpvChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  if (env.APPIMAGE) for (const k of APPIMAGE_VARS) Reflect.deleteProperty(out, k)
  return out
}
