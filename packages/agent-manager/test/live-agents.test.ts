import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileLiveAgentRegistry,
  defaultLiveAgentRegistryDir,
  isProcessAlive,
  parseLiveAgentEntry,
  type LiveAgentEntry,
} from '../src/registry/live-agents.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function registryFixture(
  alive: Set<number>,
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void },
): Promise<{ dir: string; registry: FileLiveAgentRegistry }> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-live-')), 'live-agents')
  dirs.push(path.dirname(dir))
  return { dir, registry: new FileLiveAgentRegistry({ dir, isAlive: (pid) => alive.has(pid), logger }) }
}

function spyLogger(): { warnings: string[]; info(): void; warn(message: string): void; error(): void } {
  const warnings: string[] = []
  return { warnings, info() {}, warn: (message: string) => warnings.push(message), error() {} }
}

function entry(overrides: Partial<LiveAgentEntry> = {}): LiveAgentEntry {
  return {
    agentId: 'agent-a',
    ownerPid: 100,
    ownerGeneration: 'generation-a',
    controlSocketPath: '/run/dsh/control/generation-a.sock',
    roleId: 'worker',
    harness: 'codex',
    harnessSessionId: 'thread-a',
    cwd: '/projects/demo',
    journalFile: '/projects/demo/.dsh/runtime/agent-events.jsonl',
    keepAliveAfterTask: true,
    interactionMode: 'headless',
    showWindow: false,
    spawnedAt: 10,
    ...overrides,
  }
}

describe('FileLiveAgentRegistry', () => {
  it('registers, lists in spawn order, and unregisters entries', async () => {
    const { dir, registry } = await registryFixture(new Set([100, 200]))
    expect(await registry.list()).toEqual([])
    await registry.register(entry({ agentId: 'agent-b', ownerPid: 200, spawnedAt: 20, windowHandle: 'win-1' }))
    await registry.register(entry())
    expect((await registry.list()).map(({ agentId }) => agentId)).toEqual(['agent-a', 'agent-b'])
    expect((await registry.list())[1]?.windowHandle).toBe('win-1')
    expect((await readdir(dir)).sort()).toEqual(['agent-a.json', 'agent-b.json'])

    await registry.register(entry({ roleId: 'replaced' }))
    expect((await registry.list())[0]?.roleId).toBe('replaced')

    await registry.unregister('agent-a')
    await registry.unregister('never-registered')
    expect((await registry.list()).map(({ agentId }) => agentId)).toEqual(['agent-b'])
    expect(registry.path).toBe(dir)
  })

  it('prunes entries whose owner process is gone and skips malformed files', async () => {
    const { dir, registry } = await registryFixture(new Set([100]))
    await registry.register(entry())
    await registry.register(entry({ agentId: 'agent-dead', ownerPid: 999 }))
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8')
    await writeFile(path.join(dir, 'partial.json'), JSON.stringify({ agentId: 'x' }), 'utf8')
    await writeFile(path.join(dir, 'notes.txt'), 'ignored', 'utf8')

    expect((await registry.list()).map(({ agentId }) => agentId)).toEqual(['agent-a'])
    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual(['agent-a.json', 'broken.json', 'notes.txt', 'partial.json'])
  })

  it('logs (but does not touch) an orphaned child process when its dead owner is pruned', async () => {
    const logger = spyLogger()
    // ownerPid 999 is dead; childPid 100 is alive (isAlive only knows 100)
    // — the owner crashed without going through its own dispose()/close()
    // and left its harness process running.
    const { dir, registry } = await registryFixture(new Set([100]), logger)
    await registry.register(entry({ agentId: 'agent-orphaned', ownerPid: 999, childPid: 100 }))

    expect(await registry.list()).toEqual([])
    expect(await readdir(dir)).toEqual([])
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toMatch(/agent-orphaned/)
    expect(logger.warnings[0]).toMatch(/pid 999/)
    expect(logger.warnings[0]).toMatch(/pid 100/)
    expect(logger.warnings[0]).toMatch(/orphaned/)
  })

  it('does not log an orphan warning when the dead owner has no childPid, or its childPid is also dead', async () => {
    const logger = spyLogger()
    const { registry } = await registryFixture(new Set([100]), logger)
    await registry.register(entry({ agentId: 'agent-no-child', ownerPid: 999 }))
    await registry.register(entry({ agentId: 'agent-dead-child', ownerPid: 999, childPid: 888 }))

    expect(await registry.list()).toEqual([])
    expect(logger.warnings).toEqual([])
  })

  it('serializes a fast register/unregister pair so no ghost survives', async () => {
    const { dir, registry } = await registryFixture(new Set([100]))
    const pending = registry.register(entry())
    const withdrawn = registry.unregister('agent-a')
    await Promise.all([pending, withdrawn])
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses unsafe agent ids as file names', async () => {
    const { registry } = await registryFixture(new Set([100]))
    await expect(registry.register(entry({ agentId: '../escape' }))).rejects.toThrow(/Unsafe agent id/)
  })

  it('writes entries atomically as a complete JSON document', async () => {
    const { dir, registry } = await registryFixture(new Set([100]))
    await registry.register(entry())
    expect(parseLiveAgentEntry(await readFile(path.join(dir, 'agent-a.json'), 'utf8'))).toEqual(entry())
  })
})

describe('parseLiveAgentEntry', () => {
  it('rejects anything short of a complete entry', () => {
    expect(parseLiveAgentEntry('')).toBeUndefined()
    expect(parseLiveAgentEntry('null')).toBeUndefined()
    expect(parseLiveAgentEntry('[]')).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), ownerPid: '100' }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), ownerGeneration: '' }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), controlSocketPath: undefined }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), interactionMode: 'tui' }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), cwd: '' }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), spawnedAt: 'now' }))).toBeUndefined()
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), windowHandle: 7 }))).toEqual(entry())
    // childPid is optional and diagnostic-only: a malformed value
    // is dropped, not treated as grounds to reject the whole entry.
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), childPid: 'not-a-pid' }))).toEqual(entry())
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), childPid: 4242 }))).toEqual(entry({ childPid: 4242 }))
    // roleVersion/roleHash are optional on the wire so an entry
    // from an older agent-manager stays discoverable; when present they round
    // trip, and a malformed value is dropped rather than rejecting the entry.
    expect(parseLiveAgentEntry(JSON.stringify(entry({ roleVersion: '2.0.0', roleHash: 'a'.repeat(64) }))))
      .toEqual(entry({ roleVersion: '2.0.0', roleHash: 'a'.repeat(64) }))
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), roleHash: 42 }))).toEqual(entry())
    expect(parseLiveAgentEntry(JSON.stringify({ ...entry(), roleVersion: '' }))).toEqual(entry())
  })
})

describe('registry defaults', () => {
  it('lives under DSH_HOME when set, else ~/.dsh', () => {
    expect(defaultLiveAgentRegistryDir({ DSH_HOME: '/srv/dsh' }, '/home/me'))
      .toBe(path.join('/srv/dsh', 'runtime', 'agent-manager', 'live-agents'))
    expect(defaultLiveAgentRegistryDir({ DSH_HOME: '  ' }, '/home/me'))
      .toBe(path.join('/home/me', '.dsh', 'runtime', 'agent-manager', 'live-agents'))
    expect(defaultLiveAgentRegistryDir({}, '/home/me'))
      .toBe(path.join('/home/me', '.dsh', 'runtime', 'agent-manager', 'live-agents'))
  })

  it('probes process liveness with signal 0', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(2 ** 31 - 7)).toBe(false)
  })
})
