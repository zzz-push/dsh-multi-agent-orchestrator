import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentManager } from '../src/manager.js'
import type { AgentCommand, Channel, ChannelCapabilities, ChannelOpenOptions, ChannelSession, ChatReply } from '../src/channel/types.js'
import { FileRoleProvider } from '../src/role/file-provider.js'
import {
  composeScenarioTask,
  composeSystemPrompt,
  computeProjectLayerHash,
  findScenario,
  listScenarios,
  parseProjectLayerDocument,
  UnknownScenarioError,
} from '../src/role/project-layer.js'
import { computeRoleHash } from '../src/role/role-hash.js'
import { RoleSchemaError, validateRoleDocument } from '../src/role/schema-validator.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const roleYaml = `api_version: dsh.orchestrator/v1alpha1
kind: Role
metadata:
  role_id: implementer
  name: Implementer
  version: 3.0.0
  description: generic implementer
system_prompt: |
  You implement things carefully.
execution:
  harness: test
  keep_alive_after_task: false
scenarios:
  - name: bug-fix
    title: Fix a bug
    when: A reproducible defect is reported.
    guidance: Reproduce it with a failing test first.
    done_when: The new test passes and nothing else broke.
  - name: small-feature
    when: A small, well-specified feature.
    guidance: Keep the change minimal.
`

const layerYaml = `api_version: dsh.orchestrator/v1alpha1
kind: ProjectLayer
metadata:
  role_id: implementer
context: |
  Register every stopgap in maintenance register.
scenarios:
  - name: maintenance
    title: 修复一条技术债登记项
    when: 任务是解决 maintenance register 里的某一条。
    guidance: 先读登记内容，改完移到已解决区。
  - name: bug-fix
    when: A defect in this project.
    guidance: Also add a line to the changelog.
`

async function project(options: { layer?: string; extraLayer?: string } = {}): Promise<string> {
  const root = await tempDir('dsh-project-layer-')
  await mkdir(path.join(root, '.dsh', 'roles'), { recursive: true })
  await writeFile(path.join(root, '.dsh', 'roles', 'implementer.yaml'), roleYaml, 'utf8')
  if (options.layer !== undefined) {
    await mkdir(path.join(root, '.dsh', 'project-layer'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'project-layer', 'implementer.yaml'), options.layer, 'utf8')
  }
  if (options.extraLayer !== undefined) {
    await writeFile(path.join(root, '.dsh', 'project-layer', 'another.yaml'), options.extraLayer, 'utf8')
  }
  return root
}

describe('role scenarios', () => {
  it('parses a role\'s scenarios into their camelCase form', async () => {
    const provider = new FileRoleProvider({ rolesDir: path.join(await project(), '.dsh', 'roles') })
    const role = (await provider.get('implementer'))!
    expect(role.scenarios).toEqual([
      { name: 'bug-fix', title: 'Fix a bug', when: 'A reproducible defect is reported.', guidance: 'Reproduce it with a failing test first.', doneWhen: 'The new test passes and nothing else broke.' },
      { name: 'small-feature', when: 'A small, well-specified feature.', guidance: 'Keep the change minimal.' },
    ])
  })

  it('rejects scenarios that cannot be selected or followed', () => {
    const base = { api_version: 'dsh.orchestrator/v1alpha1', kind: 'Role', metadata: { role_id: 'r', name: 'R', version: '1.0.0', description: 'd' }, system_prompt: 'p', execution: { harness: 'test', keep_alive_after_task: false } }
    const withScenarios = (scenarios: unknown) => () => validateRoleDocument({ ...base, scenarios }, 'role.yaml')
    expect(withScenarios('nope')).toThrow(/scenarios 必须是列表/)
    expect(withScenarios([{ name: 'Bad Name', when: 'w', guidance: 'g' }])).toThrow(/只能用小写字母/)
    expect(withScenarios([{ name: 'a', when: 'w', guidance: 'g' }, { name: 'a', when: 'w', guidance: 'g' }])).toThrow(/重复: a/)
    expect(withScenarios([{ name: 'a', when: 'w' }])).toThrow(/scenarios\[0\]\.guidance/)
    expect(withScenarios([{ name: 'a', when: 'w', guidance: 'g', title: 3 }])).toThrow(RoleSchemaError)
    expect(validateRoleDocument(base, 'role.yaml').scenarios).toBeUndefined()
  })
})

describe('project layer', () => {
  it('is picked up from .dsh/project-layer next to .dsh/roles, and does not change the role\'s hash', async () => {
    const withLayer = await project({ layer: layerYaml })
    const withoutLayer = await project()
    const layered = (await new FileRoleProvider({ rolesDir: path.join(withLayer, '.dsh', 'roles') }).get('implementer'))!
    const plain = (await new FileRoleProvider({ rolesDir: path.join(withoutLayer, '.dsh', 'roles') }).get('implementer'))!

    expect(layered.projectLayer).toMatchObject({ roleId: 'implementer', context: 'Register every stopgap in maintenance register.\n' })
    expect(layered.projectLayer?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(plain.projectLayer).toBeUndefined()
    // Same role, two projects, one hash — the whole point of keeping the layer out.
    expect(computeRoleHash(layered)).toBe(computeRoleHash(plain))
    // And it can be switched off.
    const bare = await new FileRoleProvider({ rolesDir: path.join(withLayer, '.dsh', 'roles'), projectLayerDir: false }).get('implementer')
    expect(bare?.projectLayer).toBeUndefined()
  })

  it('hashes what the layer says, not where it was read from', async () => {
    const text = (await import('yaml')).parse(layerYaml) as unknown
    const a = parseProjectLayerDocument(text, '/one/place.yaml')
    const b = parseProjectLayerDocument(text, '/another/place.yaml')
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toBe(computeProjectLayerHash(a))
    expect(computeProjectLayerHash({ ...a, context: 'changed' })).not.toBe(a.hash)
  })

  it('runs the project layer\'s verification rules together with the role\'s', async () => {
    const layerWithRules = `${layerYaml}verification:
  - type: content_policy
    config:
      deny_patterns:
        - regex: "jest\\\\.fn"
          message: "this project uses vitest"
`
    const root = await project({ layer: layerWithRules })
    const role = (await new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') }).get('implementer'))!
    expect(role.projectLayer?.verification).toHaveLength(1)
    expect(() => parseProjectLayerDocument({ kind: 'ProjectLayer', metadata: { role_id: 'x' }, verification: [{ type: 'nope' }] }, 'f.yaml')).toThrow(/verification\[0\]\.type/)

    class Replying extends RecordingChannel {
      override async sendChat(_session: ChannelSession, text: string): Promise<ChatReply> {
        this.sent.push(text)
        return { text: 'used jest.fn() for the mock', durationMs: 0, toolCalls: [] }
      }
    }
    const channel = new Replying()
    const manager = new AgentManager({ roleProvider: new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') }), journalFile: path.join(root, 'events.jsonl'), cwd: root, channels: [channel], liveAgentRegistryDir: false })
    try {
      const handle = await manager.spawn('implementer')
      const reply = await manager.sendChat(handle.agentId, 'task')
      expect(reply.verification?.passed).toBe(false)
      expect(reply.verification?.results.some((result) => !result.passed && result.message?.includes('vitest'))).toBe(true)
    } finally {
      await manager.dispose()
    }
  })

  it('rejects documents that are not a project layer for exactly one role', async () => {
    expect(() => parseProjectLayerDocument({ kind: 'Role', metadata: { role_id: 'x' } }, 'f.yaml')).toThrow(/期望 kind: ProjectLayer/)
    expect(() => parseProjectLayerDocument({ kind: 'ProjectLayer', metadata: {} }, 'f.yaml')).toThrow(/metadata.role_id/)
    expect(() => parseProjectLayerDocument({ kind: 'ProjectLayer', metadata: { role_id: 'x' }, context: '' }, 'f.yaml')).toThrow(/context/)
    const doubled = await project({ layer: layerYaml, extraLayer: layerYaml })
    await expect(new FileRoleProvider({ rolesDir: path.join(doubled, '.dsh', 'roles') }).get('implementer')).rejects.toThrow(/两个项目层文件/)
  })

  it('lists role and project scenarios, the project\'s replacing a role one of the same name', async () => {
    const root = await project({ layer: layerYaml })
    const provider = new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') })
    const role = (await provider.get('implementer'))!
    expect(listScenarios(role).map((scenario) => [scenario.name, scenario.source])).toEqual([
      ['bug-fix', 'project'], ['small-feature', 'role'], ['maintenance', 'project'],
    ])
    expect(findScenario(role, 'bug-fix').guidance).toBe('Also add a line to the changelog.')
    expect(() => findScenario(role, 'nope')).toThrow(UnknownScenarioError)
    expect(() => findScenario(role, 'nope')).toThrow(/available: bug-fix, small-feature, maintenance/)
    expect((await provider.list())[0]?.scenarios).toEqual(['bug-fix', 'small-feature', 'maintenance'])
  })

  it('appends the project context to the system prompt under its own heading', async () => {
    const role = (await new FileRoleProvider({ rolesDir: path.join(await project({ layer: layerYaml }), '.dsh', 'roles') }).get('implementer'))!
    expect(composeSystemPrompt(role)).toBe('You implement things carefully.\n\n## 本项目补充说明\n\nRegister every stopgap in maintenance register.\n')
    expect(composeSystemPrompt({ ...role, projectLayer: undefined })).toBe(role.systemPrompt)
  })

  it('puts only the chosen scenario in front of the task', () => {
    const task = composeScenarioTask({ name: 'maintenance', title: '修复一条技术债登记项', when: 'w', guidance: 'g', doneWhen: 'd', source: 'project' }, 'Fix behavior')
    expect(task).toBe('[场景：修复一条技术债登记项]（本项目）\n适用情况：w\n\n做法：\ng\n\n完成标准：d\n\n---\n\nFix behavior')
    expect(composeScenarioTask({ name: 'x', when: 'w', guidance: 'g' }, 'T')).toBe('[场景：x]\n适用情况：w\n\n做法：\ng\n\n---\n\nT')
  })
})

class RecordingChannel implements Channel {
  readonly harness = 'test'
  readonly capabilities: ChannelCapabilities = { streaming: false, keepAlive: true, resumeSession: false, forkSession: false, readHistory: false, injectSystemPrompt: true }
  readonly opened: ChannelOpenOptions[] = []
  readonly sent: string[] = []
  async open(options: ChannelOpenOptions): Promise<ChannelSession> {
    this.opened.push(options)
    return { agentId: options.agentId, harness: this.harness, sessionId: `s-${options.agentId}` }
  }
  async sendCommand(_session: ChannelSession, _command: AgentCommand): Promise<void> {}
  async sendChat(_session: ChannelSession, text: string): Promise<ChatReply> {
    this.sent.push(text)
    return { text: 'ok', durationMs: 0, toolCalls: [] }
  }
  async close(): Promise<void> {}
}

describe('AgentManager with a project layer', () => {
  it('spawns with the composed prompt, records the layer hash, and applies a selected scenario to one task', async () => {
    const root = await project({ layer: layerYaml })
    const channel = new RecordingChannel()
    const manager = new AgentManager({
      roleProvider: new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') }),
      journalFile: path.join(root, 'events.jsonl'),
      cwd: root,
      channels: [channel],
      liveAgentRegistryDir: false,
    })
    try {
      const handle = await manager.spawn('implementer')
      const role = (await new FileRoleProvider({ rolesDir: path.join(root, '.dsh', 'roles') }).get('implementer'))!
      expect(channel.opened[0]?.systemPrompt).toContain('## 本项目补充说明')
      expect(handle.projectLayerHash).toBe(role.projectLayer?.hash)
      expect(handle.roleHash).toBe(computeRoleHash(role))
      const spawned = (await readFile(path.join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> }).find((event) => event.kind === 'agent.spawned')
      expect(spawned?.payload.projectLayerHash).toBe(role.projectLayer?.hash)

      await manager.sendChat(handle.agentId, 'Fix behavior', { scenario: 'maintenance' })
      await manager.sendChat(handle.agentId, 'Plain task')
      expect(channel.sent[0]).toMatch(/^\[场景：修复一条技术债登记项\]（本项目）\n适用情况：/)
      expect(channel.sent[0]?.endsWith('---\n\nFix behavior')).toBe(true)
      expect(channel.sent[1]).toBe('Plain task')

      await expect(manager.sendChat(handle.agentId, 'x', { scenario: 'no-such' })).rejects.toBeInstanceOf(UnknownScenarioError)
      expect(channel.sent).toHaveLength(2)
    } finally {
      await manager.dispose()
    }
  })
})
