// Imported first by core's entry (index.ts): ES modules run their imports in order, so this runs before any
// package below it loads. Settings that packages read once, when they load, go here.
//
// WebTorrent pulls in `ws` (unused: trackers are off). Keep it from loading its optional native addons
// (ADR 0001 finding 3). main passes the same two in the utilityProcess env (core-host.ts), so they hold from
// the first line in Electron too; index.ts loads the WebTorrent side of core only after this has run.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

export {}
