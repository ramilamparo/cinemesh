import { FakeCore } from './fake-core'
import { SCENARIOS, SCENARIO_CORE, SCENARIO_NOTICES, isScenario } from './scenarios'
import { simulate } from './simulate'

export { FakeCore } from './fake-core'
export { SCENARIOS, type ScenarioName } from './scenarios'

declare global {
  interface Window {
    /** the browser mock's handle, for scripting from the devtools console */
    wtMock?: FakeCore
  }
}

/** Builds the fake bridge for a plain browser: ?mock=<scenario>&dark=1. */
export function createBrowserMock(search: string): FakeCore {
  const params = new URLSearchParams(search)
  const name = params.get('mock') ?? 'home'
  const fake = new FakeCore({
    ...(isScenario(name) ? SCENARIO_CORE[name]?.() : {}),
    state: isScenario(name) ? SCENARIOS[name]() : SCENARIOS.home(),
    systemDark: params.get('dark') === '1' || matchMedia('(prefers-color-scheme: dark)').matches,
    clipboard: params.get('clipboard') ?? '',
  })
  // after the store has connected: notices are events, not part of the snapshot
  const notices = isScenario(name) ? (SCENARIO_NOTICES[name]?.() ?? []) : []
  for (const n of notices) fake.later(600, () => fake.emit('notice', n))
  simulate(fake)
  window.wtMock = fake
  return fake
}
