// Global shortcuts must not steal keys from controls that use them: Space activates buttons and toggles
// checkboxes, arrows move sliders, carets and select options.

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel'])

export function consumesKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false
  const el = target.closest(
    'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role]',
  )
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role')
  if (tag === 'textarea' || tag === 'select' || el.hasAttribute('contenteditable')) return true
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase()
    if (TEXT_INPUT_TYPES.has(type) || type === 'range') return true
    return key === ' '
  }
  // the timeline slider handles arrows itself; Space still toggles playback there
  if (role === 'slider') return key !== ' '
  if (role === 'textbox' || role === 'listbox' || role === 'radiogroup') return true
  if (tag === 'button' || tag === 'a' || role === 'button' || role === 'switch' || role === 'radio') {
    return key === ' ' || key === 'Enter'
  }
  return false
}

export type PlaybackShortcut = { kind: 'toggle' } | { kind: 'seekRel'; deltaS: number }

export function shortcutFor(
  e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>,
): PlaybackShortcut | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  if (consumesKey(e.target, e.key)) return null
  switch (e.key) {
    case ' ':
      return { kind: 'toggle' }
    case 'ArrowLeft':
      return { kind: 'seekRel', deltaS: -5 }
    case 'ArrowRight':
      return { kind: 'seekRel', deltaS: 5 }
    default:
      return null
  }
}
