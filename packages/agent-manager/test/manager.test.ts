import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentManager } from '../src/manager.js'
import { JournalWriter } from '../src/journal/writer.js'
import { computeRoleHash } from '../src/role/role-hash.js'
import type { LiveAgentEntry } from '../src/registry/live-agents.js'
import DshAgentManagerPlugin, { agentManagerService } from '../src/index.js'
import type {
  AgentCommand,
  Channel,
  ChannelCapabilities,
  ChannelOpenOptions,
  ChannelSession,
  ChatReply,
  SendChatOptions,
} from '../src/channel/types.js'
import type { RoleDefinition, RoleProvider, RoleSummary } from '../src/role/types.js'
import { AgentAlreadyExistsError, AgentNotFoundError, AgentOwnerUnreachableError, RoleNotFoundError, UnknownHarnessError } from '../src/errors.js'
import { PolicyError } from '../src/policy/types.js'

const dirs: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

class StaticRoles implements RoleProvider {
  constructor(private readonly roles: RoleDefinition[]) {}
  async get(roleId: string): Promise<RoleDefinition | undefined> {
    return this.roles.find((role) => role.roleId === roleId)
  }
  async list(): Promise<RoleSummary[]> {
    return this.roles.map((role) => ({
      roleId: role.roleId,
      name: role.name,
      version: role.version,
      harness: role.execution.harness,
      keepAliveAfterTask: role.execution.keepAliveAfterTask,
    }))
  }
}

class RecordingChannel implements Channel {
  readonly harness = 'test'
  readonly capabilities: ChannelCapabilities = {
    streaming: false,
    keepAlive: true,
    resumeSession: false,
    forkSession: false,
    readHistory: false,
    injectSystemPrompt: true,
  }
  readonly opened: ChannelOpenOptions[] = []
  closeCount = 0
  private readonly options = new Map<string, ChannelOpenOptions>()

  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    this.opened.push(options)
    this.options.set(options.agentId, options)
    return { agentId: options.agentId, harness: this.harness, sessionId: `session-${options.agentId}` }
  }
  async sendCommand(session: ChannelSession, command: AgentCommand): Promise<void> {
    const sink = this.options.get(session.agentId)?.onEvent
    sink?.({ kind: 'command.sent', role: 'user', payload: command })
    sink?.({ kind: 'message', role: 'assistant', payload: { text: 'command complete' } })
  }
  async sendChat(session: ChannelSession, text: string, options?: SendChatOptions): Promise<ChatReply> {
    const sink = this.options.get(session.agentId)?.onEvent
    sink?.({ kind: 'chat.sent', role: 'user', payload: { text } })
    sink?.({ kind: 'message', role: 'user', payload: { text } })
    sink?.({ kind: 'message', role: 'assistant', payload: { text: `reply:${text}` } })
    sink?.({ kind: 'chat.replied', role: 'assistant', payload: { text: `reply:${text}` } })
    return { text: `reply:${text}`, durationMs: options?.timeoutMs ?? 0, toolCalls: [] }
  }
  async close(session: ChannelSession): Promise<void> {
    const options = this.options.get(session.agentId)
    if (options === undefined) return
    this.options.delete(session.agentId)
    this.closeCount += 1
    options.onEvent?.({ kind: 'agent.exited', role: 'system', payload: { exitCode: 0, signal: null } })
  }
}

function role(overrides: Partial<RoleDefinition['execution']> = {}): RoleDefinition {
  return {
    roleId: overrides.keepAliveAfterTask === false ? 'one-shot' : 'kept',
    name: 'Test role',
    version: '1.0.0',
    description: 'test',
    systemPrompt: 'SYSTEM_ROLE',
    capabilities: [],
    execution: {
      harness: 'test',
      keepAliveAfterTask: true,
      chatTimeoutMs: 123,
      ...overrides,
    },
    raw: {},
  }
}

/** A control-socket directory straight under the OS temp root (see `managerFixture`), removed after the test. */
async function tempControlDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-ctrl-'))
  dirs.push(dir)
  return dir
}

async function managerFixture(roles: RoleDefinition[], idFactory: () => string = () => 'agent-1') {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-manager-'))
  dirs.push(dir)
  const controlSocketDir = await tempControlDir()
  const channel = new RecordingChannel()
  const manager = new AgentManager({
    roleProvider: new StaticRoles(roles),
    journalFile: path.join(dir, 'events.jsonl'),
    // Isolate from the real .dsh/policy.yaml: AgentManager.spawn() lazily loads
    // project policy from `cwd`, and without an explicit override here it fell
    // back to process.cwd() — the real repo root when running via `pnpm test`.
    // That accidentally picked up the real policy once it started existing
    // (a real dispatch), breaking this fixture's "unknown harness passes
    // through unresolved" assumption. Point it at the fixture's own tmpdir,
    // which has no .dsh/policy.yaml, matching the other isolation already done
    // for the journal file above.
    cwd: dir,
    channels: [channel],
    idFactory,
    // Same isolation for the cross-process live-agent registry: the default
    // is the shared ~/.dsh directory, which a test must never touch.
    liveAgentRegistryDir: path.join(dir, 'live-agents'),
    // Control sockets need their own short-lived directory, not
    // nested under `dir`: `dir` already sits deep under the OS temp root
    // (macOS in particular: `/var/folders/<hash>/T/dsh-manager-<rand>`), and
    // a Unix domain socket path is capped at ~104 bytes (macOS) / 108
    // (Linux) — stacking another subdirectory plus a socket filename on top
    // of that pushes past the limit. A directory straight under the OS temp
    // root leaves the same room production code gets from
    // `defaultControlSocketDir()`.
    controlSocketDir,
  })
  return { manager, channel, dir, registryDir: path.join(dir, 'live-agents') }
}

describe('AgentManager', () => {
  it('lets a spawn request override the role sandbox, gated by the project policy', async () => {
    // No policy file in the fixture cwd → the override passes through as-is.
    const open = await managerFixture([role({ sandbox: 'plan' })])
    await open.manager.spawn({ roleId: 'kept', sandbox: 'workspace-write' })
    expect(open.channel.opened[0]?.sandbox).toBe('workspace-write')
    await open.manager.dispose()

    // With a policy that does not list the override, it is downgraded exactly
    // like a role declaration would be, and the violation is journaled.
    const gated = await managerFixture([role({ sandbox: 'plan' })])
    await mkdir(path.join(gated.dir, '.dsh'), { recursive: true })
    await writeFile(path.join(gated.dir, '.dsh', 'policy.yaml'), 'allowedHarnesses: [test]\nallowedSandboxModes: [plan]\n')
    const handle = await gated.manager.spawn({ roleId: 'kept', sandbox: 'workspace-write' })
    expect(gated.channel.opened[0]?.sandbox).toBe('plan')
    const violations = await gated.manager.readConversation({ agentId: handle.agentId, kinds: ['policy.violation'] })
    expect(violations.items).toHaveLength(1)
    expect(JSON.stringify(violations.items[0]?.payload)).toContain('workspace-write')
    await gated.manager.dispose()
  })

  it('refuses to start an agent whose sandbox the policy prohibits outright, instead of granting the request', async () => {
    const gated = await managerFixture([role({ sandbox: 'plan' })])
    await mkdir(path.join(gated.dir, '.dsh'), { recursive: true })
    await writeFile(path.join(gated.dir, '.dsh', 'policy.yaml'), 'allowedHarnesses: [test]\nallowedSandboxModes: []\n')
    await expect(gated.manager.spawn({ roleId: 'kept', sandbox: 'bypassPermissions' })).rejects.toBeInstanceOf(PolicyError)
    expect(gated.channel.opened).toHaveLength(0)
    await gated.manager.dispose()
  })

  it('lets a spawn request override the role harness, gated by the project policy', async () => {
    // The override decides the channel: no channel named 'other' is registered here.
    const open = await managerFixture([role()])
    await expect(open.manager.spawn({ roleId: 'kept', harness: 'other' })).rejects.toBeInstanceOf(UnknownHarnessError)
    await open.manager.dispose()

    // A harness the policy does not allow is downgraded and journaled, like a role's own declaration.
    const gated = await managerFixture([role()])
    await mkdir(path.join(gated.dir, '.dsh'), { recursive: true })
    await writeFile(path.join(gated.dir, '.dsh', 'policy.yaml'), 'allowedHarnesses: [test]\n')
    const handle = await gated.manager.spawn({ roleId: 'kept', harness: 'other' })
    expect(gated.channel.opened).toHaveLength(1)
    const violations = await gated.manager.readConversation({ agentId: handle.agentId, kinds: ['policy.violation'] })
    expect(JSON.stringify(violations.items[0]?.payload)).toContain('other')
    await gated.manager.dispose()
  })

  it('gives a role that declares no turn timeout the project default, and keeps a declared one', async () => {
    const declared: RoleDefinition = { ...role(), roleId: 'declared', raw: { execution: { chat_timeout_ms: 999 } }, execution: { ...role().execution, chatTimeoutMs: 999 } }
    // `role()` has execution.chatTimeoutMs 123 but nothing in `raw`: the
    // shape a loader produces for a role file that leaves the timeout out.
    const noPolicy = await managerFixture([role(), declared])
    const plain = await noPolicy.manager.spawn('kept')
    expect((await noPolicy.manager.sendChat(plain.agentId, 'hi')).durationMs).toBe(123)
    await noPolicy.manager.dispose()

    let next = 0
    const withPolicy = await managerFixture([role(), declared], () => `agent-${(next += 1)}`)
    await mkdir(path.join(withPolicy.dir, '.dsh'), { recursive: true })
    await writeFile(path.join(withPolicy.dir, '.dsh', 'policy.yaml'), 'allowedHarnesses: [test]\ndefaults:\n  chatTimeoutMs: 4567\n')
    const defaulted = await withPolicy.manager.spawn('kept')
    const own = await withPolicy.manager.spawn('declared')
    expect((await withPolicy.manager.sendChat(defaulted.agentId, 'hi')).durationMs).toBe(4567)
    expect((await withPolicy.manager.sendChat(own.agentId, 'hi')).durationMs).toBe(999)
    // A timeout the caller names still wins over both.
    expect((await withPolicy.manager.sendChat(own.agentId, 'hi', { timeoutMs: 42 })).durationMs).toBe(42)
    const spawned = await withPolicy.manager.readConversation({ agentId: defaulted.agentId, kinds: ['agent.spawned'] })
    expect(spawned.items[0]?.payload).toMatchObject({ chatTimeoutMs: 4567 })
    expect((await withPolicy.manager.liveAgentRegistry!.list()).find((entry) => entry.agentId === own.agentId)).toMatchObject({ chatTimeoutMs: 999 })
    await withPolicy.manager.dispose()
  })

  it('owns agent ids, injects role prompts, and exposes journal history', async () => {
    const { manager, channel } = await managerFixture([role({ tools: ['Read'], sandbox: 'plan' })])
    const handle = await manager.spawn('kept')
    expect(handle.agentId).toBe('agent-1')
    expect(handle.harnessSessionId).toBe('session-agent-1')
    expect(channel.opened[0]?.systemPrompt).toBe('SYSTEM_ROLE')
    expect(channel.opened[0]?.tools).toEqual(['Read'])
    expect(channel.opened[0]?.sandbox).toBe('plan')
    const reply = await manager.sendChat(handle.agentId, 'hello')
    expect(reply).toMatchObject({ text: 'reply:hello', durationMs: 123 })
    const first = await manager.readConversation({ agentId: handle.agentId, kinds: ['message'], limit: 1 })
    expect(first.items[0]?.role).toBe('user')
    expect(first.nextCursor).toBeDefined()
    const second = await manager.readConversation({ agentId: handle.agentId, after: first.nextCursor, kinds: ['message'] })
    expect(second.items[0]?.role).toBe('assistant')
    await manager.dispose()
    expect(channel.closeCount).toBe(1)
  })

  it('records which role version and content hash a child was spawned from', async () => {
    const definition = role()
    const { manager } = await managerFixture([definition])
    const handle = await manager.spawn('kept')
    const expectedHash = computeRoleHash(definition)

    // The durable record: agent.spawned carries both, always.
    const spawned = await manager.readConversation({ agentId: handle.agentId, kinds: ['agent.spawned'] })
    expect(spawned.items).toHaveLength(1)
    expect(spawned.items[0]!.payload).toMatchObject({
      roleId: 'kept',
      roleVersion: '1.0.0',
      roleHash: expectedHash,
    })
    // The in-process convenience view agrees with it.
    expect(handle.roleVersion).toBe('1.0.0')
    expect(handle.roleHash).toBe(expectedHash)

    // Editing the role file after the fact must not rewrite history: a second
    // child from the edited definition gets a different hash, the first
    // child's journal entry keeps the original.
    const edited = { ...definition, systemPrompt: 'SYSTEM_ROLE (edited)' }
    const { manager: second } = await managerFixture([edited], () => 'agent-2')
    const other = await second.spawn('kept')
    expect(other.roleHash).not.toBe(expectedHash)
    expect(other.roleHash).toBe(computeRoleHash(edited))
    const first = await manager.readConversation({ agentId: handle.agentId, kinds: ['agent.spawned'] })
    expect(first.items[0]!.payload).toMatchObject({ roleHash: expectedHash })

    await manager.dispose()
    await second.dispose()
  })

  it('automatically closes one-shot roles after a command', async () => {
    const oneShot = role({ keepAliveAfterTask: false })
    const { manager, channel } = await managerFixture([oneShot])
    const handle = await manager.spawnAgent({ roleId: 'one-shot' })
    await manager.sendCommand(handle.agentId, { kind: 'task', payload: {}, text: 'finish' })
    expect(manager.get(handle.agentId)?.status).toBe('exited')
    expect(channel.closeCount).toBe(1)
    await expect(manager.sendChat(handle.agentId, 'too late')).rejects.toBeInstanceOf(AgentNotFoundError)
    await manager.dispose()
  })

  it('rejects unknown roles, unknown harnesses, and duplicate generated ids', async () => {
    const { manager } = await managerFixture([role()])
    await expect(manager.spawn('missing')).rejects.toBeInstanceOf(RoleNotFoundError)
    await manager.spawn('kept')
    await expect(manager.spawn('kept')).rejects.toBeInstanceOf(AgentAlreadyExistsError)
    await manager.dispose()

    const unknown = role({ harness: 'missing-harness' })
    const second = await managerFixture([unknown])
    await expect(second.manager.spawn('kept')).rejects.toBeInstanceOf(UnknownHarnessError)
    await second.manager.dispose()
  })

  it('advertises live children to other processes and withdraws them on close', async () => {
    const { manager, dir, registryDir } = await managerFixture([role()])
    const handle = await manager.spawn({ roleId: 'kept', cwd: dir })
    expect(handle.cwd).toBe(path.resolve(dir))

    // register() is fire-and-forget from spawn; list() is queued behind it.
    const advertised = await manager.liveAgentRegistry!.list()
    expect(advertised).toHaveLength(1)
    expect(advertised[0]).toMatchObject({
      agentId: 'agent-1',
      ownerPid: process.pid,
      roleId: 'kept',
      roleVersion: '1.0.0',
      roleHash: computeRoleHash(role()),
      harness: 'test',
      harnessSessionId: 'session-agent-1',
      cwd: path.resolve(dir),
      journalFile: path.join(dir, 'events.jsonl'),
      keepAliveAfterTask: true,
      interactionMode: 'headless',
      showWindow: false,
    })
    expect(await readdir(registryDir)).toEqual(['agent-1.json'])
    expect(JSON.parse(await readFile(path.join(registryDir, 'agent-1.json'), 'utf8'))).toMatchObject({ agentId: 'agent-1' })

    // Own children are never reported twice through discover().
    const discovered = await manager.discover()
    expect(discovered.map(({ agentId, external, ownerPid }) => ({ agentId, external, ownerPid })))
      .toEqual([{ agentId: 'agent-1', external: false, ownerPid: process.pid }])

    await manager.close(handle.agentId)
    expect(await manager.liveAgentRegistry!.list()).toEqual([])
    await manager.dispose()
    expect(await readdir(registryDir)).toEqual([])
  })

  it('advertises the underlying child pid as childPid, when the Channel reports one', async () => {
    class PidReportingChannel extends RecordingChannel {
      override async open(options: ChannelOpenOptions): Promise<ChannelSession> {
        return { ...(await super.open(options)), pid: 424242 }
      }
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-manager-'))
    dirs.push(dir)
    const manager = new AgentManager({
      roleProvider: new StaticRoles([role()]),
      journalFile: path.join(dir, 'events.jsonl'),
      cwd: dir,
      channels: [new PidReportingChannel()],
      liveAgentRegistryDir: path.join(dir, 'live-agents'),
      controlSocketDir: await tempControlDir(),
    })
    const handle = await manager.spawn('kept')
    expect(handle.pid).toBe(424242)
    expect((await manager.liveAgentRegistry!.list())[0]).toMatchObject({ childPid: 424242 })
    await manager.dispose()
  })

  it('withdraws the advertisement when the child exits on its own', async () => {
    const { manager, registryDir } = await managerFixture([role({ keepAliveAfterTask: false })])
    const handle = await manager.spawnAgent({ roleId: 'one-shot' })
    // list() queues behind the in-flight register() from spawn.
    expect((await manager.liveAgentRegistry!.list()).map(({ agentId }) => agentId)).toEqual(['agent-1'])
    expect(await readdir(registryDir)).toEqual(['agent-1.json'])
    await manager.sendCommand(handle.agentId, { kind: 'task', payload: {}, text: 'finish' })
    expect(manager.get(handle.agentId)?.status).toBe('exited')
    expect(await manager.liveAgentRegistry!.list()).toEqual([])
    await manager.dispose()
  })

  it('discovers agents advertised by another process and reads their journal', async () => {
    const { manager, dir, registryDir } = await managerFixture([role()])
    await manager.spawn('kept')

    // Simulate a script in another process: its own journal plus a registry
    // entry whose owner pid is alive (this test process stands in for it).
    const otherJournal = path.join(dir, 'other', 'events.jsonl')
    const writer = new JournalWriter({ file: otherJournal })
    writer.append('agent-ext', 'agent.spawned', 'system', { roleId: 'worker', harness: 'codex', cwd: dir, keepAliveAfterTask: true })
    writer.append('agent-ext', 'message', 'assistant', { text: 'hello from elsewhere' })
    await writer.dispose()
    const entry: LiveAgentEntry = {
      agentId: 'agent-ext',
      ownerPid: process.ppid,
      ownerGeneration: 'generation-ext',
      // Nothing is listening here — this "other process" is only simulated
      // by writing its journal and registry entry directly, so forwarding a
      // write operation to it must fail as unreachable, not succeed.
      controlSocketPath: path.join(dir, 'control', 'generation-ext.sock'),
      roleId: 'worker',
      harness: 'codex',
      harnessSessionId: 'thread-ext',
      cwd: path.join(dir, 'worktree'),
      journalFile: otherJournal,
      keepAliveAfterTask: true,
      interactionMode: 'headless',
      showWindow: false,
      spawnedAt: 1,
    }
    await writeFile(path.join(registryDir, 'agent-ext.json'), JSON.stringify(entry))
    // A ghost left by a crashed owner is pruned, not listed.
    await writeFile(path.join(registryDir, 'agent-ghost.json'), JSON.stringify({ ...entry, agentId: 'agent-ghost', ownerPid: 2 ** 31 - 7 }))

    const discovered = await manager.discover()
    expect(discovered.map(({ agentId, external, status }) => ({ agentId, external, status }))).toEqual([
      { agentId: 'agent-1', external: false, status: 'open' },
      { agentId: 'agent-ext', external: true, status: 'open' },
    ])
    expect(discovered[1]).toMatchObject({ ownerPid: process.ppid, cwd: path.join(dir, 'worktree'), harnessSessionId: 'thread-ext' })
    expect((await readdir(registryDir)).sort()).toEqual(['agent-1.json', 'agent-ext.json'])

    // The simulated other process wrote a legacy entry (no
    // roleVersion/roleHash): it must still be discovered, with the fields
    // simply absent rather than faked.
    const ext = (await manager.discover()).find((agent) => agent.agentId === 'agent-ext')
    expect(ext).toBeDefined()
    expect(ext!.roleVersion).toBeUndefined()
    expect(ext!.roleHash).toBeUndefined()
    const page = await manager.readConversation({ agentId: 'agent-ext', kinds: ['message'] })
    expect(page.items.map((item) => item.payload)).toEqual([{ text: 'hello from elsewhere' }])
    // Unknown ids still read this manager's own journal (and find nothing).
    expect((await manager.readConversation({ agentId: 'nobody' })).items).toEqual([])
    // Forwarding to this "external" agent's control socket fails (nothing is
    // actually listening there — see the comment on `entry` above), which is
    // reported as the owner being unreachable, not "unknown agent" — behavior
    // forwards write operations instead of refusing them outright now.
    await expect(manager.sendChat('agent-ext', 'hi')).rejects.toBeInstanceOf(AgentOwnerUnreachableError)
    // The stale entry is pruned once forwarding discovers it is unreachable.
    expect((await manager.liveAgentRegistry!.list()).map(({ agentId }) => agentId)).toEqual(['agent-1'])
    await manager.dispose()
  })

  it('forwards sendChat, sendCommand, and close to another AgentManager over a real control socket', async () => {
    const owner = await managerFixture([role()])
    const handle = await owner.manager.spawn({ roleId: 'kept', cwd: owner.dir })

    // owner.manager's real control server is genuinely listening at the real
    // controlSocketPath it just advertised. Two real AgentManager instances
    // in this one test process unavoidably share process.pid, so — exactly
    // like the fabricated "another process" entry above — the only way to
    // make a second manager treat this as foreign is to override ownerPid
    // directly, while keeping the real (live) controlSocketPath.
    const [realEntry] = await owner.manager.liveAgentRegistry!.list()
    const foreignEntry: LiveAgentEntry = { ...realEntry!, ownerPid: process.ppid }
    await writeFile(path.join(owner.registryDir, `${handle.agentId}.json`), JSON.stringify(foreignEntry))

    const caller = new AgentManager({
      roleProvider: new StaticRoles([role()]),
      journalFile: path.join(owner.dir, 'caller-events.jsonl'),
      cwd: owner.dir,
      channels: [new RecordingChannel()],
      liveAgentRegistryDir: owner.registryDir,
      controlSocketDir: path.join(owner.dir, 'control'),
    })

    try {
      const chatReply = await caller.sendChat(handle.agentId, 'hello')
      expect(chatReply).toMatchObject({ text: 'reply:hello' })
      // No timeout named by the caller: the owner applies the agent's own
      // (123 here), not a default the forwarding side made up.
      expect(chatReply.durationMs).toBe(123)
      expect((await caller.sendChat(handle.agentId, 'again', { timeoutMs: 77 })).durationMs).toBe(77)

      await caller.sendCommand(handle.agentId, { kind: 'task', payload: {}, text: 'go' })
      // keepAliveAfterTask: true — the forwarded command must not close it.
      expect(owner.manager.get(handle.agentId)?.status).toBe('open')

      await caller.close(handle.agentId)
      expect(owner.manager.get(handle.agentId)?.status).toBe('exited')
    } finally {
      await caller.dispose()
      await owner.manager.dispose()
    }
  })

  it('forwards a chat to an owner whose turn takes a while, and a forwarded timeout leaves the agent listed', async () => {
    // A real turn is not instant. Seen in real use: from a DSH page the
    // forwarded chat was aborted 9 ms after sending, and the forwarding side
    // then deleted the (healthy) agent from the shared registry.
    class SlowChannel extends RecordingChannel {
      override async sendChat(session: ChannelSession, text: string, options?: SendChatOptions): Promise<ChatReply> {
        await new Promise<void>((resolve, reject) => {
          // Longer than a microtask, shorter than the role's 123 ms turn limit.
          const timer = setTimeout(resolve, 60)
          options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
        })
        return super.sendChat(session, text, options)
      }
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-manager-'))
    dirs.push(dir)
    const registryDir = path.join(dir, 'live-agents')
    const owner = new AgentManager({
      roleProvider: new StaticRoles([role()]),
      journalFile: path.join(dir, 'events.jsonl'),
      cwd: dir,
      channels: [new SlowChannel()],
      liveAgentRegistryDir: registryDir,
      controlSocketDir: await tempControlDir(),
    })
    const handle = await owner.spawn({ roleId: 'kept', cwd: dir })
    const [realEntry] = await owner.liveAgentRegistry!.list()
    await writeFile(path.join(registryDir, `${handle.agentId}.json`), JSON.stringify({ ...realEntry!, ownerPid: process.ppid }))
    const caller = new AgentManager({
      roleProvider: new StaticRoles([role()]),
      journalFile: path.join(dir, 'caller-events.jsonl'),
      cwd: dir,
      channels: [new RecordingChannel()],
      liveAgentRegistryDir: registryDir,
      controlSocketDir: await tempControlDir(),
    })
    try {
      await expect(caller.sendChat(handle.agentId, 'slow one')).resolves.toMatchObject({ text: 'reply:slow one' })
      expect((await owner.readConversation({ agentId: handle.agentId, kinds: ['error'] })).items).toEqual([])

      await expect(caller.sendChat(handle.agentId, 'too slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'agent-forward-failed' })
      expect((await caller.liveAgentRegistry!.list()).map((entry) => entry.agentId)).toContain(handle.agentId)
    } finally {
      await caller.dispose()
      await owner.dispose()
    }
  })

  it('runs without a registry when opted out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-manager-'))
    dirs.push(dir)
    const manager = new AgentManager({
      roleProvider: new StaticRoles([role()]),
      journalFile: path.join(dir, 'events.jsonl'),
      cwd: dir,
      channels: [new RecordingChannel()],
      liveAgentRegistryDir: false,
    })
    expect(manager.liveAgentRegistry).toBeUndefined()
    const handle = await manager.spawn('kept')
    expect((await manager.discover()).map(({ agentId, external }) => ({ agentId, external }))).toEqual([{ agentId: handle.agentId, external: false }])
    await manager.dispose()
  })
})

describe('agent-manager Cordis plugin', () => {
  it('provides and disposes the service through the real Fiber lifecycle', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-'))
    dirs.push(dir)
    const ctx = new Context()
    const fiber = await ctx.plugin(DshAgentManagerPlugin, {
      rolesDir: path.join(dir, 'roles'),
      journalFile: path.join(dir, 'events.jsonl'),
      cwd: process.cwd(),
    })
    expect(ctx.get(agentManagerService)).toBeInstanceOf(AgentManager)
    await fiber.dispose()
    expect(ctx.get(agentManagerService)).toBeUndefined()
  })
})
