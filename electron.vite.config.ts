import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const r = (p: string): string => resolve(import.meta.dirname, p)

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        // index: the main process. core: the 'wt-core' utilityProcess (src/main/paths.ts coreEntry()).
        // The worker_threads entries are emitted next to core.js as out/main/index-worker.js and
        // out/main/hash-worker.js. Core starts them with new Worker(new URL('./hash-worker.js', import.meta.url))
        // (and './index-worker.js'), resolved from the module that does it, so every module of the main build must
        // land directly in out/main: shared chunks too (chunkFileNames below has no chunks/ folder), or
        // import.meta.url in a chunk would point one folder down. electron-builder ships them via `files: out/**`.
        input: {
          index: r('src/main/index.ts'),
          core: r('src/core/index.ts'),
          'index-worker': r('src/core/media/index-worker.ts'),
          'hash-worker': r('src/core/transfer/hash-worker.ts'),
        },
        output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: r('src/preload/index.ts') },
        // sandboxed preloads cannot be ES modules
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    build: {
      rolldownOptions: { input: { index: r('src/renderer/index.html') } },
    },
    plugins: [react()],
  },
})
