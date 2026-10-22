import log from 'electron-log/main'
import { app } from 'electron'
import { join } from 'node:path'

export function setupMainLog(): typeof log {
  log.transports.file.resolvePathFn = () => join(app.getPath('logs'), 'main.log')
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = app.isPackaged ? false : 'info'
  log.errorHandler.startCatching({ showDialog: false })
  return log
}

export { log }
