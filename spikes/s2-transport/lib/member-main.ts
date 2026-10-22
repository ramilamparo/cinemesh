// Child process entry: runs one member (normal mode) or all four (one-process mode), driven over IPC.
import { startMember, type Command, type MemberConfig } from './member.js'

const send = (m: object): void => {
  process.send?.(m)
}

process.once('message', async (msg: { configs: MemberConfig[] }) => {
  const handlers = await Promise.all(
    msg.configs.map((cfg) => startMember(cfg, (m) => send({ ...m, name: cfg.name }))),
  )
  process.on('message', async (cmd: Command) => {
    await Promise.all(handlers.map((h) => h(cmd)))
    if (cmd.t === 'finish') {
      send({ t: 'bye' })
      setTimeout(() => process.exit(0), 200)
    }
  })
})
process.on('disconnect', () => process.exit(0))
