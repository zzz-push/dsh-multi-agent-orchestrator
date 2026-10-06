import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentManager } from '../src/manager.js'
import type { RoleDefinition, RoleProvider, RoleSummary } from '../src/role/types.js'
import type {
  Channel,
  ChannelCapabilities,
  ChannelOpenOptions,
  ChannelSession,
  ChatReply,
  SendChatOptions,
  AgentCommand,
} from '../src/channel/types.js'

const dirs: string[] = []
afterEach(async () => {
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

class TestChannel implements Channel {
  readonly harness = 'test'
  readonly capabilities: ChannelCapabilities = {
    streaming: false,
    keepAlive: true,
    resumeSession: false,
    forkSession: false,
    readHistory: false,
    injectSystemPrompt: true,
  }
  private readonly options = new Map<string, ChannelOpenOptions>()
  private responseText = 'Agent response with valid output'

  setResponseText(text: string) {
    this.responseText = text
  }

  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
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
    sink?.({ kind: 'message', role: 'assistant', payload: { text: this.responseText } })
    sink?.({ kind: 'chat.replied', role: 'assistant', payload: { text: this.responseText } })
    return { text: this.responseText, durationMs: options?.timeoutMs ?? 0, toolCalls: [] }
  }
  async close(session: ChannelSession): Promise<void> {
    const options = this.options.get(session.agentId)
    if (options === undefined) return
    this.options.delete(session.agentId)
    options.onEvent?.({ kind: 'agent.exited', role: 'system', payload: { exitCode: 0, signal: null } })
  }
}

describe('AgentManager - Verification Integration', () => {
  let manager: AgentManager
  let roleProvider: StaticRoles
  let channel: TestChannel
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'dsh-verification-'))
    dirs.push(testDir)
    channel = new TestChannel()
  })

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'dsh-verification-'))
    dirs.push(testDir)
    channel = new TestChannel()
  })

  afterEach(async () => {
    if (manager) {
      await manager.dispose()
    }
  })

  it('应该在有验证规则时自动运行验证', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-with-verification',
      name: '测试角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: {
        harness: 'test',
        chatTimeoutMs: 60000,
        keepAliveAfterTask: false,
      },
      verification: [
        {
          type: 'structure',
          config: {
            requireSections: ['Summary', 'Details'],
          },
        },
      ],
    }

    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    const handle = await manager.spawn('test-role-with-verification')
    await manager.sendChat(handle.agentId, 'test message')

    // 验证事件应该被记录
    const result = await manager.readConversation({
      agentId: handle.agentId,
      limit: 100,
    })

    const verificationEvents = result.items.filter(
      (e) => e.kind === 'verification.completed' || e.kind === 'verification.error'
    )

    expect(verificationEvents.length).toBeGreaterThan(0)
  })

  it('应该在没有验证规则时跳过验证', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-no-verification',
      name: '无验证角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: {
        harness: 'test',
        chatTimeoutMs: 60000,
        keepAliveAfterTask: false,
      },
      // 没有 verification 字段
    }

    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    const handle = await manager.spawn('test-role-no-verification')
    await manager.sendChat(handle.agentId, 'test message')

    // 不应该有验证事件
    const result = await manager.readConversation({
      agentId: handle.agentId,
      limit: 100,
    })

    const verificationEvents = result.items.filter(
      (e) => e.kind === 'verification.completed' || e.kind === 'verification.error'
    )

    expect(verificationEvents.length).toBe(0)
  })

  it('应该在空验证规则数组时跳过验证', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-empty-verification',
      name: '空验证角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: {
        harness: 'test',
        chatTimeoutMs: 60000,
        keepAliveAfterTask: false,
      },
      verification: [], // 空数组
    }

    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    const handle = await manager.spawn('test-role-empty-verification')
    await manager.sendChat(handle.agentId, 'test message')

    // 不应该有验证事件
    const result = await manager.readConversation({
      agentId: handle.agentId,
      limit: 100,
    })

    const verificationEvents = result.items.filter(
      (e) => e.kind === 'verification.completed' || e.kind === 'verification.error'
    )

    expect(verificationEvents.length).toBe(0)
  })

  it('应该记录验证失败的详细信息', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-fail-verification',
      name: '验证失败角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: {
        harness: 'test',
        chatTimeoutMs: 60000,
        keepAliveAfterTask: false,
      },
      verification: [
        {
          type: 'structure',
          config: {
            requireSections: ['NonExistentSection'],
          },
        },
      ],
    }

    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    // Set response without required section
    channel.setResponseText('Response without required section')

    const handle = await manager.spawn('test-role-fail-verification')
    await manager.sendChat(handle.agentId, 'test message')

    const result = await manager.readConversation({
      agentId: handle.agentId,
      limit: 100,
    })

    const verificationEvent = result.items.find((e) => e.kind === 'verification.completed')

    expect(verificationEvent).toBeDefined()
    expect(verificationEvent?.payload).toHaveProperty('failed')
    expect(verificationEvent?.payload).toHaveProperty('results')
  })

  it('验证失败不应阻止 sendChat 返回', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-verification-non-blocking',
      name: '验证不阻塞角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: {
        harness: 'test',
        chatTimeoutMs: 60000,
        keepAliveAfterTask: false,
      },
      verification: [
        {
          type: 'structure',
          config: {
            requireSections: ['NonExistentSection'],
          },
        },
      ],
    }

    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    channel.setResponseText('Response without required section')

    const handle = await manager.spawn('test-role-verification-non-blocking')

    // 验证失败不应该阻止 sendChat 返回结果
    const reply = await manager.sendChat(handle.agentId, 'test message')

    expect(reply).toBeDefined()
    expect(reply.text).toBe('Response without required section')

    // 验证事件应该记录失败
    const result = await manager.readConversation({
      agentId: handle.agentId,
      limit: 100,
    })

    const verificationEvent = result.items.find((e) => e.kind === 'verification.completed')
    expect(verificationEvent).toBeDefined()
    expect(verificationEvent?.payload.failed).toBeGreaterThan(0)
  })

  // Before this, a caller had no way to know from the returned
  // ChatReply itself whether the role's own verification rules thought the
  // reply was adequate — only the journal carried that signal, and nothing
  // consulted it. These use the real `output_structure` rule type/config
  // shape (packages/core/src/verification/checkers/output-structure.ts),
  // unlike the `'structure'`/`requireSections` rules used elsewhere in this
  // file, which do not match any real checker and only ever hit the
  // "unknown rule type" fallback branch.
  it('附回 reply.verification：规则通过时 passed 为 true', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-verification-passes',
      name: '验证通过角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: { harness: 'test', chatTimeoutMs: 60000, keepAliveAfterTask: false },
      verification: [{ type: 'output_structure', config: { required_sections: ['Summary'] } }],
    }
    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })
    channel.setResponseText('## Summary\ndone')

    const handle = await manager.spawn('test-role-verification-passes')
    const reply = await manager.sendChat(handle.agentId, 'test message')

    expect(reply.verification).toBeDefined()
    expect(reply.verification?.passed).toBe(true)
    expect(reply.verification?.results).toHaveLength(1)
    expect(reply.verification?.results[0]?.passed).toBe(true)
  })

  it('附回 reply.verification：规则不通过时 passed 为 false', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-verification-fails-reply',
      name: '验证失败角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: { harness: 'test', chatTimeoutMs: 60000, keepAliveAfterTask: false },
      verification: [{ type: 'output_structure', config: { required_sections: ['Summary'] } }],
    }
    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })
    channel.setResponseText('我打算先读一下文档，然后开始实现。')

    const handle = await manager.spawn('test-role-verification-fails-reply')
    const reply = await manager.sendChat(handle.agentId, 'test message')

    // The reply itself still comes back (verification never blocks sendChat
    // from resolving) — but a caller checking reply.verification.passed
    // instead of just reply.text now has a mechanical signal available,
    // exactly the one earlier behavior incident showed nobody was consulting.
    expect(reply.text).toBe('我打算先读一下文档，然后开始实现。')
    expect(reply.verification).toBeDefined()
    expect(reply.verification?.passed).toBe(false)
    expect(reply.verification?.results.some((r) => !r.passed)).toBe(true)
  })

  it('没有声明验证规则时 reply.verification 为 undefined', async () => {
    const role: RoleDefinition = {
      roleId: 'test-role-no-verification-reply',
      name: '无验证角色',
      version: '1.0.0',
      systemPrompt: 'Test prompt',
      execution: { harness: 'test', chatTimeoutMs: 60000, keepAliveAfterTask: false },
    }
    roleProvider = new StaticRoles([role])
    manager = new AgentManager({
      cwd: testDir,
      roleProvider,
      journalFile: path.join(testDir, 'events.jsonl'),
      liveAgentRegistryDir: false,
      channels: [channel],
      idFactory: () => 'test-agent-id',
    })

    const handle = await manager.spawn('test-role-no-verification-reply')
    const reply = await manager.sendChat(handle.agentId, 'test message')

    expect(reply.verification).toBeUndefined()
  })
})
