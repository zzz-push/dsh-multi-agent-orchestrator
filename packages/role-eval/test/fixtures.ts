import { exec as execCb } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  ChannelTimeoutError,
  type AgentCommand,
  type Channel,
  type ChannelCapabilities,
  type ChannelOpenOptions,
  type ChannelSession,
  type ChatReply,
  type SendChatOptions,
} from '@dsh/agent-manager'

const exec = promisify(execCb)

export const dirs: string[] = []
export async function cleanupDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export async function git(cwd: string, command: string): Promise<string> {
  const { stdout } = await exec(`git ${command}`, { cwd })
  return stdout.trim()
}

export function roleYaml(version: string, prompt: string, extra = ''): string {
  return [
    'role_id: worker',
    'name: Worker',
    `version: ${version}`,
    'description: test worker',
    'execution:',
    '  harness: fake',
    '  keep_alive_after_task: true',
    'system_prompt: |',
    `  ${prompt}`,
    extra,
  ].join('\n')
}

/**
 * A repo whose `.dsh/roles/worker.yaml` went from v1.0.0 (first commit) to
 * v2.0.0 (second commit), plus a file the task will ask the role to touch.
 * Returns the two commits so a test can point role sources at either.
 */
export async function createRoleHistoryRepo(): Promise<{ repo: string; v1: string; v2: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'dsh-role-eval-repo-'))
  dirs.push(repo)
  await git(repo, 'init --quiet')
  await git(repo, 'config user.name "Test User"')
  await git(repo, 'config user.email "test@example.com"')
  await mkdir(path.join(repo, '.dsh', 'roles'), { recursive: true })
  await writeFile(path.join(repo, '.dsh', 'roles', 'worker.yaml'), roleYaml('1.0.0', 'You are v1.'), 'utf8')
  await writeFile(path.join(repo, 'README.md'), '# fixture\n', 'utf8')
  await git(repo, 'add -A')
  await git(repo, 'commit --quiet -m "roles v1"')
  const v1 = await git(repo, 'rev-parse HEAD')
  await writeFile(path.join(repo, '.dsh', 'roles', 'worker.yaml'), roleYaml('2.0.0', 'You are v2, more careful.'), 'utf8')
  await git(repo, 'add -A')
  await git(repo, 'commit --quiet -m "roles v2"')
  const v2 = await git(repo, 'rev-parse HEAD')
  return { repo, v1, v2 }
}

/**
 * Stand-in for a harness: on each chat it "works" by writing a file into
 * its cwd (the attempt's worktree) and emitting `toolCalls` tool events,
 * then replies with whatever the constructor was told. `behaviour` decides
 * whether it actually touches the worktree, so a test can model the
 * intent-only reply from behavior as well as an agent that does the work.
 */
export class FakeHarnessChannel implements Channel {
  readonly harness = 'fake'
  readonly capabilities: ChannelCapabilities = {
    streaming: false,
    keepAlive: true,
    resumeSession: false,
    forkSession: false,
    readHistory: false,
    injectSystemPrompt: true,
  }
  readonly opened: ChannelOpenOptions[] = []
  private readonly options = new Map<string, ChannelOpenOptions>()

  constructor(
    private readonly behaviour: {
      toolCalls: number
      writeFile?: { name: string; content: string }
      replyText?: string
      /** After doing its work, never finish the turn: honour the caller's timeout and throw the channel's timeout error. */
      hang?: boolean
      /** Hang only for the agent whose system prompt contains this text — one arm stalls, the other does not. */
      hangFor?: string
      /** Called with the worktree path during the turn — a place for a test to look around as the agent would. */
      inspect?: (cwd: string) => Promise<void>
    } = { toolCalls: 2, writeFile: { name: 'created.txt', content: 'done\n' } },
  ) {}

  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    this.opened.push(options)
    this.options.set(options.agentId, options)
    return { agentId: options.agentId, harness: this.harness, sessionId: `fake-${options.agentId}`, pid: process.pid }
  }
  async sendCommand(session: ChannelSession, command: AgentCommand): Promise<void> {
    this.options.get(session.agentId)?.onEvent?.({ kind: 'command.sent', role: 'user', payload: command })
  }
  async sendChat(session: ChannelSession, text: string, control?: SendChatOptions): Promise<ChatReply> {
    const options = this.options.get(session.agentId)
    const sink = options?.onEvent
    sink?.({ kind: 'chat.sent', role: 'user', payload: { text } })
    sink?.({ kind: 'message', role: 'user', payload: { text } })
    const toolCalls: ChatReply['toolCalls'] = []
    for (let index = 0; index < this.behaviour.toolCalls; index += 1) {
      sink?.({ kind: 'tool_call', role: 'assistant', payload: { toolUseId: `t${index}`, name: 'write_file' } })
      sink?.({ kind: 'tool_result', role: 'user', payload: { toolUseId: `t${index}`, isError: false } })
      toolCalls.push({ id: `t${index}`, name: 'write_file', input: {} })
    }
    if (this.behaviour.inspect !== undefined && options?.cwd !== undefined) await this.behaviour.inspect(options.cwd)
    if (this.behaviour.writeFile !== undefined && options?.cwd !== undefined) {
      await writeFile(path.join(options.cwd, this.behaviour.writeFile.name), this.behaviour.writeFile.content, 'utf8')
    }
    const hanging = this.behaviour.hang === true
      || (this.behaviour.hangFor !== undefined && (options?.systemPrompt ?? '').includes(this.behaviour.hangFor))
    if (hanging) {
      const timeoutMs = control?.timeoutMs ?? 50
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      const error = new ChannelTimeoutError(session.agentId, timeoutMs)
      // Like the real channels: the timeout is journaled as an error event, then thrown.
      sink?.({ kind: 'error', role: 'system', payload: { code: 'timeout', message: error.message } })
      throw error
    }
    const reply = this.behaviour.replyText ?? `## 实现概述\n${options?.systemPrompt ?? ''} did the task.`
    sink?.({ kind: 'message', role: 'assistant', payload: { text: reply } })
    sink?.({ kind: 'chat.replied', role: 'assistant', payload: { text: reply } })
    return { text: reply, model: 'fake-1', durationMs: 5, toolCalls }
  }
  async close(session: ChannelSession): Promise<void> {
    const options = this.options.get(session.agentId)
    if (options === undefined) return
    this.options.delete(session.agentId)
    options.onEvent?.({ kind: 'agent.exited', role: 'system', payload: { exitCode: 0, signal: null } })
  }
}
