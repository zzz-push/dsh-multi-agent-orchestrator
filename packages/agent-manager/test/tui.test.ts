import { afterEach, describe, expect, it } from 'vitest'
import { TuiWindowChannel, type TuiLaunchSpec, type TuiWindowManager } from '../src/channel/tui.js'
import type {
  AgentCommand,
  Channel,
  ChannelCapabilities,
  ChannelOpenOptions,
  ChannelSession,
  ChatReply,
  SendChatOptions,
} from '../src/channel/types.js'

const capabilities: ChannelCapabilities = {
  streaming: false,
  keepAlive: true,
  resumeSession: true,
  forkSession: false,
  readHistory: true,
  injectSystemPrompt: true,
}

class FakeChannel implements Channel {
  readonly harness = 'fake-harness'
  readonly capabilities = capabilities
  readonly sessions = new Map<string, ChannelSession>()
  readonly calls: string[] = []

  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    const session = {
      agentId: options.agentId,
      harness: this.harness,
      sessionId: `thread-${options.agentId}`,
      endpoint: `ws://127.0.0.1/${options.agentId}`,
    }
    this.sessions.set(options.agentId, session)
    return session
  }

  async sendCommand(_session: ChannelSession, _command: AgentCommand): Promise<void> {
    this.calls.push('command')
  }

  async sendChat(_session: ChannelSession, text: string, _options?: SendChatOptions): Promise<ChatReply> {
    this.calls.push(`chat:${text}`)
    return { text: `reply:${text}`, durationMs: 1, toolCalls: [] }
  }

  async close(session: ChannelSession): Promise<void> {
    this.calls.push(`close:${session.agentId}`)
  }
}

class FakeWindowManager implements TuiWindowManager {
  readonly specs: Array<{ command: string; args: readonly string[]; handle?: string }> = []
  readonly events: string[] = []

  async create(spec: { command: string; args: readonly string[]; sessionName?: string }) {
    this.specs.push({ command: spec.command, args: spec.args, handle: spec.sessionName })
    return {
      handle: spec.sessionName ?? 'generated',
      open: async () => { this.events.push('open') },
      close: async () => { this.events.push('close') },
      terminate: async () => { this.events.push('terminate') },
    }
  }
}

function launch(overrides: Partial<TuiLaunchSpec> = {}): TuiLaunchSpec {
  return {
    harness: 'fake-harness',
    enabled: true,
    ready: 'afterFirstTurnStart',
    command: 'fake-tui',
    buildArgs: ({ session }) => ['resume', session.endpoint ?? '', session.sessionId],
    reattachOnRestart: true,
    interaction: 'interactive',
    ...overrides,
  }
}

describe('TuiWindowChannel', () => {
  const channels: Array<{ channel: TuiWindowChannel; inner: FakeChannel }> = []

  afterEach(async () => {
    await Promise.all(channels.splice(0).map(({ channel }) => channel.close({
      agentId: 'agent-1', harness: 'fake-harness', sessionId: 'thread-agent-1',
    })))
  })

  it('preserves the inner harness and defers a window until the first turn', async () => {
    const inner = new FakeChannel()
    const windows = new FakeWindowManager()
    const channel = new TuiWindowChannel({ channel: inner, launch: launch(), windowManager: windows })
    channels.push({ channel, inner })

    const session = await channel.open({ agentId: 'agent-1', showWindow: true })
    expect(channel.harness).toBe('fake-harness')
    expect(session.windowHandle).toBe('dsh-tui-fake-harness-agent-1')
    expect(windows.specs).toHaveLength(0)

    await channel.sendChat(session, 'hello')
    expect(windows.specs).toHaveLength(1)
    expect(windows.specs[0]?.args).toEqual(['resume', 'ws://127.0.0.1/agent-1', 'thread-agent-1'])
    expect(windows.events).toEqual(['open'])
  })

  it('does not create a window for headless agents', async () => {
    const inner = new FakeChannel()
    const windows = new FakeWindowManager()
    const channel = new TuiWindowChannel({ channel: inner, launch: launch(), windowManager: windows })
    channels.push({ channel, inner })

    const session = await channel.open({ agentId: 'agent-1', showWindow: false })
    expect(session.windowHandle).toBeUndefined()
    await channel.sendChat(session, 'headless')
    expect(windows.specs).toHaveLength(0)
  })

  it('terminates the per-agent window before closing the inner channel', async () => {
    const inner = new FakeChannel()
    const windows = new FakeWindowManager()
    const channel = new TuiWindowChannel({ channel: inner, launch: launch(), windowManager: windows })
    const session = await channel.open({ agentId: 'agent-1', showWindow: true })
    await channel.sendChat(session, 'hello')
    await channel.close(session)
    expect(windows.events).toEqual(['open', 'terminate'])
    expect(inner.calls).toContain('close:agent-1')
  })

  it('reopens a closed window without recreating the agent session', async () => {
    const inner = new FakeChannel()
    const windows = new FakeWindowManager()
    const channel = new TuiWindowChannel({ channel: inner, launch: launch(), windowManager: windows })
    channels.push({ channel, inner })

    const session = await channel.open({ agentId: 'agent-1', showWindow: true })
    await channel.sendChat(session, 'hello')
    await session.closeWindow?.()
    await session.openWindow?.()

    expect(windows.specs).toHaveLength(1)
    expect(windows.events).toEqual(['open', 'close', 'open'])
    expect(inner.calls).toEqual(['chat:hello'])
  })

  it('rejects a launch spec for another harness', () => {
    const inner = new FakeChannel()
    expect(() => new TuiWindowChannel({
      channel: inner,
      launch: launch({ harness: 'other' }),
      windowManager: new FakeWindowManager(),
    })).toThrow('does not match')
  })
})
