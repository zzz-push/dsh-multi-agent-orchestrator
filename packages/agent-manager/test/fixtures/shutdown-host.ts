// Host process for the installShutdownHandlers test: installs the handlers,
// starts a launcher that does not forward signals, reports the grandchild pid,
// then idles until a signal arrives.
import { installShutdownHandlers, spawnManaged } from '../../src/process.js'

installShutdownHandlers({ graceMs: 500 })
const launcher = spawnManaged({
  command: 'sh',
  args: ['-c', 'sleep 300 & echo $!; wait'],
  onStdout: (chunk) => process.stdout.write(`GRANDCHILD ${chunk.toString('utf8').trim()}\n`),
})
await launcher.spawned
setInterval(() => undefined, 1_000)
