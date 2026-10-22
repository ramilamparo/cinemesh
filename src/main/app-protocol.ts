import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { protocol } from 'electron'
import { rendererDir } from './paths.js'

export const APP_ORIGIN = 'app://bundle'
export const RENDERER_ENTRY = `${APP_ORIGIN}/index.html`

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/** Call before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ])
}

/** Serves out/renderer at app://bundle/ with a strict CSP (production builds only). */
export function serveRendererBundle(): void {
  const root = rendererDir()
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    if (url.host !== 'bundle') return new Response('not found', { status: 404 })
    const file = normalize(join(root, decodeURIComponent(url.pathname)))
    if (file !== root && !file.startsWith(root + sep)) return new Response('forbidden', { status: 403 })
    try {
      const body = await readFile(file)
      const headers: Record<string, string> = {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      }
      if (extname(file) === '.html') headers['content-security-policy'] = CSP
      return new Response(body, { headers })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
