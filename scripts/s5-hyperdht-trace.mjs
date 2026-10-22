// Preloaded into every S5 member by scripts/s5-matrix.mjs (node --import, before hyperdht loads): prints a JSON
// line {t, event: 'hyperdht-error', code} each time hyperdht constructs one of its errors.
//
// Why: a connection's socket error is all an app sees, and in hyperdht 6.34.1 it often is not the cause hyperdht
// decided on. abort() destroys the holepuncher before the socket (lib/connect.js:772-791, also 294-298 and
// 335-339); the puncher's onabort (lib/connect.js:238-241) then destroys the socket with HOLEPUNCH_ABORTED, so
// e.g. HOLEPUNCH_DOUBLE_RANDOMIZED_NATS (lib/connect.js:668-671) never reaches it. Errors are also constructed
// before hyperdht knows whether it will use them, so a traced code means "decided", not "delivered".
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const DHTError = require('hyperdht/lib/errors.js')

for (const code of Object.getOwnPropertyNames(DHTError)) {
  const make = DHTError[code]
  if (typeof make !== 'function' || !/^[A-Z][A-Z_]+$/.test(code)) continue
  DHTError[code] = function traced(...args) {
    process.stdout.write(`${JSON.stringify({ t: Date.now(), event: 'hyperdht-error', code })}\n`)
    return make.apply(this, args)
  }
}
