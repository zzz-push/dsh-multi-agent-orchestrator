import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentManager } from '../src/manager.js'
import { claudeMcpArgs, claudeSettingSourceArgs, ClaudeCodeChannel } from '../src/channel/claude-code.js'
import { CodexChannel, codexMcpServerConfig, configuredCodexMcpServers } from '../src/channel/codex.js'
import type { AgentCommand, Channel, ChannelCapabilities, ChannelOpenOptions, ChannelSession, ChatReply } from '../src/channel/types.js'
import { expandMcpServerLaunch, loadMcpServerRegistry, loadProjectPolicy } from '../src/policy/project-policy.js'
import { PolicyResolver } from '../src/policy/resolver.js'
import { FileRoleProvider } from '../src/role/file-provider.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-tools-'))
  dirs.push(dir)
  return dir
}

const contextNest = { command: 'node', args: ['/opt/example-mcp/index.js', '${projectRoot}'] }

describe('third-party tools a role declares (MCP servers)', () => {
  it('gives a role only the servers it declared, the project allows, and a launch definition exists for', () => {
    const resolver = new PolicyResolver({
      allowedMcpServers: ['example-mcp', 'search'],
      mcpServers: { 'example-mcp': contextNest, 'undeclared': { command: 'x' } },
    })
    const result = resolver.resolve({
      harness: 'claude-code',
      keepAliveAfterTask: false,
      chatTimeoutMs: 1_000,
      tools: { mcp_servers: ['example-mcp', 'search', 'forbidden'] },
    }, 'writer')

    // Declared + allowed + defined → given. Nothing the role did not declare, even if defined.
    expect(result.mcpServers).toEqual({ 'example-mcp': contextNest })
    // Asked for but not given, each with a reason the caller can see.
    expect(result.violations?.map((violation) => violation.requested)).toEqual(['forbidden', 'search'])
    expect(result.violations?.[0]?.reason).toContain('not in allowed list')
    expect(result.violations?.[1]?.reason).toContain('has no launch definition')
  })

  it('gives a role that declares nothing no third-party tools at all', () => {
    const resolver = new PolicyResolver({ mcpServers: { 'example-mcp': contextNest } })
    const result = resolver.resolve({ harness: 'claude-code', keepAliveAfterTask: false, chatTimeoutMs: 1_000 }, 'plain')
    expect(result.mcpServers).toEqual({})
    expect(result.allowed).toBe(true)
  })

  it('reads this machine\'s launch definitions and lets the project\'s own win', async () => {
    const root = await tempDir()
    const userFile = path.join(root, 'mcp-servers.yaml')
    await writeFile(userFile, 'example-mcp:\n  command: node\n  args: ["/opt/example-mcp/index.js", "${projectRoot}"]\nlocal-only:\n  command: /usr/local/bin/tool\n', 'utf8')
    await mkdir(path.join(root, '.dsh'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'policy.yaml'), 'mcpServers:\n  local-only:\n    command: npx\n    args: ["-y", "tool"]\n', 'utf8')

    expect(await loadMcpServerRegistry(userFile)).toEqual({ 'example-mcp': contextNest, 'local-only': { command: '/usr/local/bin/tool' } })
    const policy = await loadProjectPolicy(root, { mcpServersFile: userFile })
    expect(policy.mcpServers).toEqual({ 'example-mcp': contextNest, 'local-only': { command: 'npx', args: ['-y', 'tool'] } })
    expect((await loadProjectPolicy(root, { mcpServersFile: false })).mcpServers).toEqual({ 'local-only': { command: 'npx', args: ['-y', 'tool'] } })
    expect(await loadMcpServerRegistry(path.join(root, 'missing.yaml'))).toEqual({})

    await writeFile(userFile, 'broken:\n  args: [1]\n', 'utf8')
    await expect(loadMcpServerRegistry(userFile)).rejects.toThrow(/mcpServers\.broken\.command/)
  })

  it('expands ${projectRoot} and ${agentCwd} in launch definitions', () => {
    expect(expandMcpServerLaunch({ command: '${projectRoot}/bin/t', args: ['${agentCwd}', 'x'], env: { ROOT: '${projectRoot}' } }, { projectRoot: '/p', agentCwd: '/w' }))
      .toEqual({ command: '/p/bin/t', args: ['/w', 'x'], env: { ROOT: '/p' } })
  })

  it('claude: passes exactly the resolved servers, ignores every other MCP config, and pre-approves them', () => {
    expect(claudeMcpArgs(undefined)).toEqual([])
    expect(claudeMcpArgs({})).toEqual(['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'])
    const args = claudeMcpArgs({ 'example-mcp': { command: 'node', args: ['/x.js'] } })
    expect(JSON.parse(args[1]!)).toEqual({ mcpServers: { 'example-mcp': { type: 'stdio', command: 'node', args: ['/x.js'] } } })
    expect(args.slice(2)).toEqual(['--strict-mcp-config', '--allowedTools', 'mcp__example-mcp'])
  })

  it('codex: reads which servers codex\'s own config declares, from the user and the project config', async () => {
    const home = await tempDir()
    const project = await tempDir()
    await writeFile(path.join(home, 'config.toml'), '[mcp_servers]\n[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."notion"] # quoted\nurl = "y"\n[plugins."browser@openai-bundled"]\nenabled = true\n', 'utf8')
    await mkdir(path.join(project, '.codex'), { recursive: true })
    await writeFile(path.join(project, '.codex', 'config.toml'), '[mcp_servers.project-db]\ncommand = "db"\n', 'utf8')
    expect((await configuredCodexMcpServers(home, project)).sort()).toEqual(['node_repl', 'notion', 'project-db'])
    expect(await configuredCodexMcpServers(path.join(home, 'missing'), path.join(project, 'missing'))).toEqual([])
  })

  it('codex: gives the declared servers and switches every other configured one off by name', () => {
    // Codex merges overrides into its config (probed during testing); an empty table removes nothing.
    expect(codexMcpServerConfig({ 'example-mcp': { command: 'node', args: ['x'] } }, ['node_repl', 'example-mcp', 'notion']))
      .toEqual({ node_repl: { enabled: false }, notion: { enabled: false }, 'example-mcp': { command: 'node', args: ['x'] } })
    expect(codexMcpServerConfig({}, [])).toEqual({})
  })

  it('codex: launches with plugins off, sends the thread config, and journals a server it started anyway', async () => {
    const home = await tempDir()
    await writeFile(path.join(home, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "x"\n', 'utf8')
    const fixture = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url))
    const channel = new CodexChannel({ command: process.execPath, commandArgs: [fixture, 'codex'], env: { CODEX_HOME: home } })
    const events: Array<{ kind: string; payload: unknown }> = []
    const session = await channel.open({ agentId: 'codex-mcp', mcpServers: { 'example-mcp': { command: 'node' } }, onEvent: (event) => events.push(event) })
    try {
      const reply = await channel.sendChat(session, 'hi')
      expect(reply.model).toBe('fake-codex-mcp:-node_repl,example-mcp|-c features.plugins=false app-server --stdio')
      // The undeclared server codex reported (twice) is one violation; the declared one is none.
      expect(events.filter((event) => event.kind === 'policy.violation').map((event) => (event.payload as { requested: string }).requested)).toEqual(['leaky-plugin-server'])
    } finally {
      await channel.close(session)
    }
  })

  it('codex: leaves launch args and config alone for a caller that resolved nothing', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url))
    const channel = new CodexChannel({ command: process.execPath, commandArgs: [fixture, 'codex'] })
    const session = await channel.open({ agentId: 'codex-plain' })
    try {
      expect((await channel.sendChat(session, 'hi')).model).toBe('fake-codex-model')
    } finally {
      await channel.close(session)
    }
  })

  it('claude: the spawned CLI actually receives the flags', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url))
    const channel = new ClaudeCodeChannel({ command: process.execPath, commandArgs: [fixture, 'claude'] })
    const session = await channel.open({ agentId: 'claude-mcp', mcpServers: { 'example-mcp': { command: 'node' } } })
    try {
      const reply = await channel.sendChat(session, 'SHOW_PROMPT')
      expect(reply.text).toContain('--strict-mcp-config')
      expect(reply.text).toContain('mcp__example-mcp')
      expect(reply.text).toContain('--setting-sources user')
    } finally {
      await channel.close(session)
    }
  })

  it('claude: loads only the user\'s settings, never the project\'s, unless the operator chose sources', () => {
    expect(claudeSettingSourceArgs([])).toEqual(['--setting-sources', 'user'])
    expect(claudeSettingSourceArgs(['--setting-sources', 'user,project'])).toEqual([])
    expect(claudeSettingSourceArgs(['--setting-sources=user,project,local'])).toEqual([])
  })
})

class RecordingChannel implements Channel {
  readonly harness = 'test'
  readonly capabilities: ChannelCapabilities = { streaming: false, keepAlive: true, resumeSession: false, forkSession: false, readHistory: false, injectSystemPrompt: true }
  readonly opened: ChannelOpenOptions[] = []
  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    this.opened.push(options)
    return { agentId: options.agentId, harness: this.harness, sessionId: 's' }
  }
  async sendCommand(_session: ChannelSession, _command: AgentCommand): Promise<void> {}
  async sendChat(): Promise<ChatReply> { return { text: 'ok', durationMs: 0, toolCalls: [] } }
  async close(): Promise<void> {}
}

describe('AgentManager: declared tools reach the agent, and the journal says which', () => {
  it('spawns with the resolved, expanded servers and records their names', async () => {
    const root = await tempDir()
    await mkdir(path.join(root, '.dsh', 'roles'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'roles', 'writer.yaml'), [
      'api_version: dsh.orchestrator/v1alpha1', 'kind: Role',
      'metadata: { role_id: writer, name: Writer, version: 1.0.0, description: d }',
      'system_prompt: write',
      'execution:', '  harness: test', '  keep_alive_after_task: false',
      '  tool_request:', '    mcp_servers: [example-mcp]', '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(root, '.dsh', 'roles', 'plain.yaml'), [
      'api_version: dsh.orchestrator/v1alpha1', 'kind: Role',
      'metadata: { role_id: plain, name: Plain, version: 1.0.0, description: d }',
      'system_prompt: p',
      'execution:', '  harness: test', '  keep_alive_after_task: false', '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(root, '.dsh', 'policy.yaml'), 'mcpServers:\n  example-mcp:\n    command: node\n    args: ["/opt/example-mcp/index.js", "${projectRoot}"]\n', 'utf8')
    const channel = new RecordingChannel()
    const manager = new AgentManager({ roleProvider: new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') }), journalFile: path.join(root, 'events.jsonl'), cwd: root, channels: [channel], liveAgentRegistryDir: false, mcpServersFile: false })
    try {
      await manager.spawn('writer')
      await manager.spawn('plain')
    } finally {
      await manager.dispose()
    }
    expect(channel.opened[0]?.mcpServers).toEqual({ 'example-mcp': { command: 'node', args: ['/opt/example-mcp/index.js', root] } })
    // A role that declared nothing gets nothing — not the harness's own servers.
    expect(channel.opened[1]?.mcpServers).toEqual({})
    const spawned = (await readFile(path.join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; payload: { roleId: string; mcpServers?: string[] } }).filter((event) => event.kind === 'agent.spawned')
    expect(spawned.map((event) => [event.payload.roleId, event.payload.mcpServers])).toEqual([['writer', ['example-mcp']], ['plain', []]])
  })
})
