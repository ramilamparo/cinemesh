import { defineConfig } from '@playwright/test'

// Drives the built app (npm run build first) through Playwright's Electron support.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
