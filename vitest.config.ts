import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/{shared,core,main}/**/*.test.ts', 'test/core/**/*.test.ts', 'test/sync/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      // M8 alpha (docs/adr/0008-m8-alpha.md): opt-in, `WT_ALPHA=1 npx vitest run --project alpha`. Four members in
      // their own processes with the installed mpv, for minutes: one file at a time, so rooms never overlap.
      ...(process.env.WT_ALPHA === '1'
        ? [
            {
              test: {
                name: 'alpha',
                environment: 'node',
                include: ['test/alpha/**/*.test.ts'],
                testTimeout: 30 * 60_000,
                hookTimeout: 15 * 60_000,
                fileParallelism: false,
              },
            },
          ]
        : []),
    ],
  },
})
