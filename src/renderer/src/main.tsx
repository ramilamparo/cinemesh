import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'
import type { WtBridge } from '../../shared/ipc/app'
import { App } from './App'
import { connectStore } from './store'
import './styles/global.css'

// The CSP has no 'unsafe-eval': skip zod's `new Function` probe, which would log a CSP violation.
z.config({ jitless: true })

async function bridge(): Promise<WtBridge> {
  const real = (window as { wt?: WtBridge }).wt
  if (real) return real
  // A plain browser on the Vite dev server: drive the UI with the scriptable fake core (?mock=<scenario>).
  if (import.meta.env.DEV) return (await import('./mock')).createBrowserMock(location.search).bridge
  throw new Error('window.wt is missing: the preload did not run')
}

void bridge().then((wt) => {
  connectStore(wt)
  const root = document.getElementById('root')
  if (!root) throw new Error('#root missing from index.html')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
