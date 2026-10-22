import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Forcing a relayed path needs members that cannot reach each other directly. On one machine that means a
// private network namespace with nft dropping member-to-member UDP, which `unshare -rn` gives without root.
// Skipped where unprivileged user namespaces or nft are unavailable.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const scenario = 'test/integration/net/relay-scenario.ts'

function namespacesWork(): boolean {
  const probe = spawnSync('unshare', ['-rn', 'nft', 'list', 'ruleset'], { timeout: 5000 })
  return probe.status === 0
}

describe('relay', () => {
  it.skipIf(!namespacesWork())(
    'forced relay through a local blind relay: path relayed, bus and datagrams flow',
    () => {
      const run = spawnSync('unshare', ['-rn', 'sh', '-c', `ip link set lo up && exec node --import tsx ${scenario}`], {
        cwd: root,
        timeout: 28_000,
        encoding: 'utf8',
      })
      const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) throw new Error(`scenario failed (status ${String(run.status)}):\n${run.stdout}\n${run.stderr}`)
      const result = JSON.parse(line.slice(7)) as Record<string, unknown>
      expect(result).toMatchObject({ linked: true, path: 'relayed', relayStatus: 'ok', busOk: true })
      expect(result.pairings).toBeGreaterThan(0)
      expect(result.datagrams).toBeGreaterThan(0)
    },
    30_000,
  )
})
