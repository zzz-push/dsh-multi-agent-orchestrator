import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { spawnManaged } from '../src/process.js'
import { ChannelSpawnError } from '../src/errors.js'

describe('managed child process', () => {
  it('waits for spawn and reaps a gracefully terminated process', async () => {
    const processHandle = spawnManaged({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
    })
    await processHandle.spawned
    expect(processHandle.alive()).toBe(true)
    const exit = await processHandle.killGraceful(100)
    expect(exit.timestamp).toBeGreaterThan(0)
    expect(processHandle.alive()).toBe(false)
    processHandle.endStdin()
  })

  it('takes the grandchildren down with a launcher that does not forward signals', async () => {
    // `sh` is a stand-in for the npm launcher scripts of codex/claude: it
    // spawns the "real" program and dies on SIGTERM without forwarding it.
    let grandchild = 0
    const processHandle = spawnManaged({
      command: 'sh',
      args: ['-c', 'sleep 300 & echo $!; wait'],
      onStdout: (chunk) => { grandchild = Number.parseInt(chunk.toString('utf8'), 10) },
    })
    await processHandle.spawned
    await vi.waitFor(() => expect(grandchild).toBeGreaterThan(0))
    expect(isAlive(grandchild)).toBe(true)

    await processHandle.killGraceful(500)

    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false))
    expect(processHandle.alive()).toBe(false)
  })

  it('installShutdownHandlers: a signalled host takes its managed process trees down with it', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/shutdown-host.ts', import.meta.url))
    const host = spawn(process.execPath, ['--import', 'tsx', fixture], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    host.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      host.on('exit', (code, signal) => resolve({ code, signal }))
    })
    let grandchild = 0
    await vi.waitFor(() => {
      const match = /GRANDCHILD (\d+)/.exec(output)
      expect(match).not.toBeNull()
      grandchild = Number.parseInt(match![1]!, 10)
    }, { timeout: 15_000 })
    expect(isAlive(grandchild)).toBe(true)

    host.kill('SIGTERM')

    // Exits on its own terms (128 + 15), not killed by the default handler.
    expect(await exited).toEqual({ code: 143, signal: null })
    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: 5_000 })
  }, 30_000)

  it('reports a missing executable through spawned and still settles exit', async () => {
    const processHandle = spawnManaged({ command: 'dsh-command-that-does-not-exist', args: [] })
    await expect(processHandle.spawned).rejects.toBeInstanceOf(ChannelSpawnError)
    const exit = await processHandle.exit
    expect(exit.code).toBeNull()
    expect(processHandle.alive()).toBe(false)
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A zombie (exited, not yet reaped by its parent) still answers signal 0.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
