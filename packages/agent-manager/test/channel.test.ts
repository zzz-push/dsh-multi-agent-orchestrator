import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCodeChannel, claudeModelArgs, claudeSandboxArgs } from '../src/channel/claude-code.js'
import { CodexChannel } from '../src/channel/codex.js'
import type { ChannelEvent, ChannelSession } from '../src/channel/types.js'
import { ChannelAbortedError, ChannelClosedError, ChannelTimeoutError } from '../src/errors.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url))
const nodeCommandArgs = (mode: string): string[] => [fixture, mode]
const sessions: Array<{ channel: ClaudeCodeChannel | CodexChannel; session: ChannelSession }> = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(({ channel, session }) => channel.close(session)))
})

function collect(): { events: ChannelEvent[]; onEvent: (event: ChannelEvent) => void } {
  const events: ChannelEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('claudeModelArgs', () => {
  it('defaults every claude sub-agent to sonnet at medium effort', () => {
    expect(claudeModelArgs({})).toEqual(['--model', 'sonnet', '--effort', 'medium'])
  })

  it('lets a caller pick another model or effort, or defer to the account default with null', () => {
    expect(claudeModelArgs({ model: 'opus', effort: 'high' })).toEqual(['--model', 'opus', '--effort', 'high'])
    expect(claudeModelArgs({ model: null })).toEqual(['--effort', 'medium'])
    expect(claudeModelArgs({ model: null, effort: null })).toEqual([])
  })
})

describe('claudeSandboxArgs', () => {
  it('maps workspace-write to acceptEdits inside the OS sandbox with no unsandboxed escape', () => {
    const args = claudeSandboxArgs('workspace-write')
    expect(args.slice(0, 3)).toEqual(['--permission-mode', 'acceptEdits', '--settings'])
    expect(JSON.parse(args[3]!)).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } })
  })

  it('passes native permission modes through and ignores everything else', () => {
    expect(claudeSandboxArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(claudeSandboxArgs('plan')).toEqual(['--permission-mode', 'plan'])
    expect(claudeSandboxArgs('read-only')).toEqual(['--permission-mode', 'dontAsk'])
    expect(claudeSandboxArgs(undefined)).toEqual([])
  })
})

describe('ClaudeCodeChannel', () => {
  it('opens with a system prompt, runs command/chat turns, and emits journal events', async () => {
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: nodeCommandArgs('claude') })
    const sink = collect()
    const session = await channel.open({ agentId: 'claude-1', systemPrompt: 'ROLE_PROMPT', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    // The real OS pid of the spawned fixture process, not a placeholder.
    expect(session.pid).toBeGreaterThan(0)
    await channel.sendCommand(session, { kind: 'task', payload: { n: 1 }, text: 'do task' })
    const reply = await channel.sendChat(session, 'SHOW_PROMPT')
    expect(reply.text).toContain('ROLE_PROMPT')
    expect(reply.model).toBe('fake-claude-model')
    expect(sink.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'command.sent',
      'message',
      'chat.sent',
      'chat.replied',
    ]))
  })

  it('captures tool calls, times out, and supports AbortSignal', async () => {
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: nodeCommandArgs('claude') })
    const sink = collect()
    const session = await channel.open({ agentId: 'claude-2', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    const toolReply = await channel.sendChat(session, 'TOOL')
    expect(toolReply.toolCalls[0]?.name).toBe('FakeTool')
    expect(sink.events.some((event) => event.kind === 'tool_result')).toBe(true)
    await expect(channel.sendChat(session, 'WAIT', { timeoutMs: 15 })).rejects.toBeInstanceOf(ChannelTimeoutError)
    const controller = new AbortController()
    const pending = channel.sendChat(session, 'WAIT', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ChannelAbortedError)
  })

  it('rejects a turn when the child exits unexpectedly and closes idempotently', async () => {
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: nodeCommandArgs('claude') })
    const sink = collect()
    const session = await channel.open({ agentId: 'claude-3', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    await expect(channel.sendChat(session, 'EXIT')).rejects.toBeInstanceOf(ChannelClosedError)
    expect(sink.events.some((event) => event.kind === 'agent.exited')).toBe(true)
    await channel.close(session)
    await expect(channel.sendChat(session, 'later')).rejects.toBeInstanceOf(ChannelClosedError)
  })
})

describe('activity and provider-retry evidence', () => {
  it('claude: turns thinking_tokens into throttled heartbeats and api_retry into a provider_retry event', async () => {
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: nodeCommandArgs('claude') })
    const sink = collect()
    const session = await channel.open({ agentId: 'claude-think', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    await channel.sendChat(session, 'THINK')
    // Five progress reports in one burst → one heartbeat at the default spacing.
    expect(sink.events.filter((event) => event.kind === 'agent.activity')).toEqual([
      { kind: 'agent.activity', role: 'system', payload: { activity: 'thinking', phase: 'progress', tokens: 100 } },
    ])
    expect(sink.events.filter((event) => event.kind === 'agent.provider_retry')).toEqual([
      { kind: 'agent.provider_retry', role: 'system', payload: { message: 'overloaded', attempt: 1, maxRetries: 10, delayMs: 500, status: 529, waitedMs: 120000 } },
    ])
  })

  it('claude: a zero heartbeat spacing records every progress report', async () => {
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: nodeCommandArgs('claude'), activityHeartbeatMs: 0 })
    const sink = collect()
    const session = await channel.open({ agentId: 'claude-think-all', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    await channel.sendChat(session, 'THINK')
    expect(sink.events.filter((event) => event.kind === 'agent.activity').map((event) => (event.payload as { tokens: number }).tokens)).toEqual([100, 200, 300, 400, 500])
  })

  it('codex: brackets the silent reasoning span and records retried requests, but not terminal errors', async () => {
    const channel = new CodexChannel({ command: process.execPath, commandArgs: nodeCommandArgs('codex') })
    const sink = collect()
    const session = await channel.open({ agentId: 'codex-think', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    await channel.sendChat(session, 'THINK')
    expect(sink.events.filter((event) => event.kind === 'agent.activity' || event.kind === 'agent.provider_retry')).toEqual([
      { kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'started' } },
      { kind: 'agent.provider_retry', role: 'system', payload: { message: 'stream disconnected before completion' } },
      { kind: 'agent.activity', role: 'system', payload: { activity: 'reasoning', phase: 'completed' } },
    ])
  })
})

describe('CodexChannel', () => {
  it('negotiates protocol v2, handles same-chunk notifications, and returns replies', async () => {
    const channel = new CodexChannel({ command: process.execPath, commandArgs: nodeCommandArgs('codex') })
    const sink = collect()
    const session = await channel.open({ agentId: 'codex-1', systemPrompt: 'CODEX_ROLE', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    const reply = await channel.sendChat(session, 'hello')
    expect(session.sessionId).toBe('fake-thread-1')
    // The real OS pid of the spawned fixture process, not a placeholder.
    expect(session.pid).toBeGreaterThan(0)
    expect(reply.text).toBe('codex:hello')
    expect(reply.model).toBe('fake-codex-with-prompt')
    expect(reply.durationMs).toBe(3)
    expect(sink.events.some((event) => event.kind === 'message')).toBe(true)
  })

  it('records codex tool events and rejects timeout/abort turns', async () => {
    const channel = new CodexChannel({ command: process.execPath, commandArgs: nodeCommandArgs('codex') })
    const sink = collect()
    const session = await channel.open({ agentId: 'codex-2', onEvent: sink.onEvent })
    sessions.push({ channel, session })
    const reply = await channel.sendChat(session, 'TOOL')
    expect(reply.toolCalls[0]?.name).toBe('shell')
    expect(sink.events.some((event) => event.kind === 'tool_result')).toBe(true)
    await expect(channel.sendChat(session, 'WAIT', { timeoutMs: 15 })).rejects.toBeInstanceOf(ChannelTimeoutError)
    await expect(channel.sendChat(session, 'WAIT_START', { timeoutMs: 10 })).rejects.toBeInstanceOf(ChannelTimeoutError)
    const controller = new AbortController()
    const pending = channel.sendChat(session, 'WAIT', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ChannelAbortedError)
  })

  it('honors an already-aborted signal before starting a turn', async () => {
    const channel = new CodexChannel({ command: process.execPath, commandArgs: nodeCommandArgs('codex') })
    const session = await channel.open({ agentId: 'codex-aborted' })
    sessions.push({ channel, session })
    const controller = new AbortController()
    controller.abort()
    await expect(channel.sendChat(session, 'should-not-start', { signal: controller.signal }))
      .rejects.toBeInstanceOf(ChannelAbortedError)
  })

  it('reports abnormal app-server exits and does not leak a process', async () => {
    const channel = new CodexChannel({ command: process.execPath, commandArgs: [fixture, 'unknown'] })
    await expect(channel.open({ agentId: 'codex-bad' })).rejects.toThrow()
  })
})
