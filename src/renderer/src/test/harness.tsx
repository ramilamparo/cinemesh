import { act } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { App } from '../App'
import { FakeCore, type FakeOptions } from '../mock/fake-core'
import { SCENARIOS, SCENARIO_CORE, type ScenarioName } from '../mock/scenarios'
import { connectStore, resetStore } from '../store'

// Minimal DOM test harness (React's act + happy-dom); @testing-library is not a dependency.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Mounted {
  fake: FakeCore
  container: HTMLElement
  cleanup: () => Promise<void>
}

/**
 * Mounts <App/> against a FakeCore in the given scenario (its state, and what its core holds besides, e.g. Recent
 * rooms), with timeScale 0: simulated delays run at once.
 */
export async function mountApp(scenario: ScenarioName = 'home', opts: FakeOptions = {}): Promise<Mounted> {
  const fake = new FakeCore({
    timeScale: 0,
    ...SCENARIO_CORE[scenario]?.(),
    ...opts,
    state: opts.state ?? SCENARIOS[scenario](),
  })
  const disconnect = connectStore(fake.bridge)
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = null
  await act(async () => {
    root = createRoot(container)
    root.render(<App />)
    await tick()
  })
  await flush()
  return {
    fake,
    container,
    cleanup: async () => {
      await act(async () => {
        root?.unmount()
        await tick()
      })
      disconnect()
      fake.dispose()
      container.remove()
      resetStore()
    },
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Lets pending promises, timers at 0 ms and React updates settle. */
export async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await tick()
    })
  }
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
    await tick()
  })
  await flush()
}

export async function typeInto(el: Element, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  // React tracks the value property; only the prototype's setter makes it see the change as user input.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with an explicit receiver below
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

export async function key(target: EventTarget, k: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    await tick()
  })
  await flush()
}

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label) return norm(label)
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) return norm(document.getElementById(labelledBy)?.textContent)
  return norm(el.textContent)
}

const IMPLICIT_ROLE: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  dialog: 'dialog',
}

/** Elements with the role (explicit or implicit) whose accessible name contains `name`. */
export function allByRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement[] {
  const els = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => {
    const tag = el.tagName.toLowerCase()
    const implicit =
      tag === 'section' && (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'))
        ? 'region'
        : IMPLICIT_ROLE[tag]
    return (el.getAttribute('role') ?? implicit) === role
  })
  if (name === undefined) return els
  return els.filter((el) => (typeof name === 'string' ? nameOf(el).includes(name) : name.test(nameOf(el))))
}

export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement {
  const found = allByRole(root, role, name)
  if (found.length === 0) throw new Error(`no ${role} named ${String(name)}`)
  return found[0] as HTMLElement
}

export function queryByRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement | null {
  return allByRole(root, role, name)[0] ?? null
}

/** The control a <label> with this text points at. */
export function byLabel(root: ParentNode, text: string): HTMLElement {
  const label = [...root.querySelectorAll('label')].find((l) => norm(l.textContent).includes(text))
  const el = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!el) throw new Error(`no control labelled ${text}`)
  return el
}

export function text(root: Element = document.body): string {
  return norm(root.textContent)
}

export function callsOf(fake: FakeCore, method: string): unknown[] {
  return fake.calls.filter((c) => c.method === method).map((c) => c.params)
}
