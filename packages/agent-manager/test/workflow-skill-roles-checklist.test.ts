import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RoleDefinition, RoleProvider, RoleSummary } from '../src/role/types.js'
import {
  extractStepRoleAssignments,
  extractStepRoleIds,
} from '../src/workflow-skill/extract-role-ids.js'
import { FileWorkflowSkillProvider } from '../src/workflow-skill/file-provider.js'
import { resolveWorkflowRoles } from '../src/workflow-skill/role-resolver.js'
import {
  formatRolesChecklist,
  writeRolesChecklist,
} from '../src/workflow-skill/roles-checklist.js'
import type { ResolveWorkflowRolesResult } from '../src/workflow-skill/role-resolver.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => {
    return rm(directory, { recursive: true, force: true })
  }))
})

describe('extractStepRoleAssignments', () => {
  it('keeps every step-to-role reference, including repeated roles', () => {
    const workflow = {
      spec: {
        steps: [
          { id: 'implement', role: 'builder' },
          { id: 'review', role: 'reviewer' },
          { id: 'fix', role: 'builder' },
          { id: 'ignored', role: 42 },
          { role: 'missing-step-id' },
        ],
      },
    }

    expect(extractStepRoleAssignments(workflow)).toEqual([
      { stepId: 'implement', roleId: 'builder' },
      { stepId: 'review', roleId: 'reviewer' },
      { stepId: 'fix', roleId: 'builder' },
    ])
    expect(extractStepRoleIds(workflow)).toEqual([
      'builder',
      'reviewer',
      'missing-step-id',
    ])
  })

  it('returns an empty list for malformed workflow values without throwing', () => {
    const malformedValues: unknown[] = [
      null,
      'workflow',
      {},
      { spec: null },
      { spec: [] },
      { spec: { steps: null } },
      { spec: { steps: {} } },
      { spec: { steps: [null, 1, 'step', { id: {}, role: 'builder' }] } },
    ]

    for (const value of malformedValues) {
      expect(() => extractStepRoleAssignments(value)).not.toThrow()
      expect(extractStepRoleAssignments(value)).toEqual([])
    }
  })
})

describe('formatRolesChecklist', () => {
  it('renders local, global, shadowed, and unresolved roles', () => {
    const assignments = [
      { stepId: 'build', roleId: 'local-builder' },
      { stepId: 'review', roleId: 'global-reviewer' },
      { stepId: 'test', roleId: 'shared' },
      { stepId: 'repair', roleId: 'shared' },
      { stepId: 'publish', roleId: 'missing' },
    ] as const
    const resolution = resolutionResult([
      {
        roleId: 'local-builder',
        source: 'local',
        shadowsGlobal: false,
      },
      {
        roleId: 'global-reviewer',
        source: 'global',
        shadowsGlobal: false,
      },
      {
        roleId: 'shared',
        source: 'local',
        shadowsGlobal: true,
      },
    ], [{ roleId: 'missing', reason: 'role missing from both sources' }])

    const output = formatRolesChecklist(assignments, resolution)

    expect(output.startsWith('<!-- 自动生成，请勿手改！ -->')).toBe(true)
    expect(output).toContain('| local-builder | 本地 (dsh/roles/) | build |')
    expect(output).toContain('| global-reviewer | 全局角色库 | review |')
    expect(output).toContain('| shared | 本地 (dsh/roles/) | test, repair | 遮蔽了同名全局角色 shared |')
    expect(output).toContain('| missing | 未解析 | publish | role missing from both sources |')
  })

  it('renders an explicit empty-reference checklist', () => {
    const output = formatRolesChecklist([], resolutionResult([], []))

    expect(output).toContain('# 角色解析清单')
    expect(output).toContain('无角色引用')
    expect(output).not.toBe('')
  })
})

describe('writeRolesChecklist', () => {
  it('creates the generated directory and replaces the complete file on every call', async () => {
    const packPath = await makeDirectory('roles-checklist-pack-')
    const firstAssignments = [{ stepId: 'first-step', roleId: 'first-role' }]
    const firstResolution = resolutionResult([
      { roleId: 'first-role', source: 'global', shadowsGlobal: false },
    ], [])

    const writtenPath = await writeRolesChecklist(packPath, firstAssignments, firstResolution)
    expect(writtenPath).toBe(path.join(packPath, 'dsh', 'generated', 'roles.md'))
    await expect(stat(writtenPath)).resolves.toBeDefined()
    await expect(readFile(writtenPath, 'utf8'))
      .resolves.toBe(formatRolesChecklist(firstAssignments, firstResolution))

    const secondAssignments = [{ stepId: 'second-step', roleId: 'second-role' }]
    const secondResolution = resolutionResult([], [
      { roleId: 'second-role', reason: 'not configured' },
    ])
    await writeRolesChecklist(packPath, secondAssignments, secondResolution)

    const finalContents = await readFile(writtenPath, 'utf8')
    expect(finalContents).toBe(formatRolesChecklist(secondAssignments, secondResolution))
    expect(finalContents).toContain('second-role')
    expect(finalContents).toContain('not configured')
    expect(finalContents).not.toContain('first-role')
    expect(finalContents).not.toContain('first-step')
  })
})

describe('roles checklist integration', () => {
  it('writes resolved and unresolved roles for a discovered workflow Pack', async () => {
    const skillsDir = await makeDirectory('skills-')
    const packPath = path.join(skillsDir, 'mixed-role-workflow')
    const localRolesDir = path.join(packPath, 'dsh', 'roles')
    await mkdir(localRolesDir, { recursive: true })
    await writeWorkflowPack(packPath)
    await writeLegacyRole(localRolesDir, 'local-writer', 'local writer prompt')

    const discovered = await new FileWorkflowSkillProvider({ skillsDir }).get('mixed-role-workflow')
    expect(discovered).toBeDefined()

    const assignments = extractStepRoleAssignments(discovered?.rawWorkflow)
    const roleIds = extractStepRoleIds(discovered?.rawWorkflow)
    const resolved = await resolveWorkflowRoles({
      localRolesDir: discovered?.localRolesDir,
      requiredRoleIds: roleIds,
      globalRoles: new StaticRoleProvider([]),
    })
    const writtenPath = await writeRolesChecklist(packPath, assignments, resolved)

    const output = await readFile(writtenPath, 'utf8')
    expect(output).toContain('| local-writer | 本地 (dsh/roles/) | draft |')
    expect(output).toContain('| missing-reviewer | 未解析 | review |')
    expect(output).toContain('角色 "missing-reviewer" 在本地和全局角色库中均未找到')
  })
})

function resolutionResult(
  resolutions: readonly Array<{
    roleId: string
    source: 'local' | 'global'
    shadowsGlobal: boolean
  }>,
  failures: readonly Array<{ roleId: string; reason: string }>,
): ResolveWorkflowRolesResult {
  return {
    roles: new Map<string, RoleDefinition>(),
    resolutions: resolutions.map((resolution) => ({
      ...resolution,
      role: role(resolution.roleId),
    })),
    failures: [...failures],
  }
}

function role(roleId: string): RoleDefinition {
  return {
    roleId,
    name: roleId,
    version: '1.0.0',
    description: `${roleId} role`,
    systemPrompt: `${roleId} prompt`,
    capabilities: [],
    execution: {
      harness: 'codex',
      keepAliveAfterTask: false,
      chatTimeoutMs: 60_000,
    },
    raw: {},
  }
}

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `dsh-${prefix}`))
  temporaryDirectories.push(directory)
  return directory
}

class StaticRoleProvider implements RoleProvider {
  constructor(private readonly definitions: readonly RoleDefinition[]) {}

  async get(roleId: string): Promise<RoleDefinition | undefined> {
    return this.definitions.find((definition) => definition.roleId === roleId)
  }

  async list(): Promise<RoleSummary[]> {
    return this.definitions.map((definition) => ({
      roleId: definition.roleId,
      name: definition.name,
      version: definition.version,
      harness: definition.execution.harness,
      keepAliveAfterTask: definition.execution.keepAliveAfterTask,
    }))
  }
}

async function writeWorkflowPack(packPath: string): Promise<void> {
  await mkdir(path.join(packPath, 'dsh'), { recursive: true })
  await writeFile(path.join(packPath, 'SKILL.md'), [
    '---',
    'name: Mixed Role Workflow',
    'description: Generates a roles checklist.',
    '---',
    'Human-readable workflow skill.',
  ].join('\n'))
  await writeFile(path.join(packPath, 'dsh', 'pack.yaml'), [
    'dsh.kind: workflow',
    'dsh.apiVersion: dsh.orchestrator/v1alpha1',
    'dsh.entry: dsh/workflow.yaml',
    'dsh.workflowId: mixed-role-workflow',
  ].join('\n'))
  await writeFile(path.join(packPath, 'dsh', 'workflow.yaml'), [
    'api_version: dsh.orchestrator/v1alpha1',
    'kind: Workflow',
    'metadata:',
    '  id: mixed-role-workflow',
    '  name: Mixed Role Workflow',
    '  description: A workflow with resolved and unresolved roles.',
    'spec:',
    '  execution:',
    '    max_parallel: 1',
    '    failure_mode: stop_after_batch',
    '    max_run_seconds: 600',
    '  workspace:',
    '    strategy: git_worktree',
    '    dirty_policy: reject',
    '    merge_strategy: deterministic_cherry_pick',
    '    final_apply: approval_required',
    '  budget:',
    '    max_total_tokens: 10000',
    '    max_cost_usd: 1',
    '    on_unknown_price: reject',
    '  steps:',
    '    - id: draft',
    '      kind: agent',
    '      role: local-writer',
    '      mode: read',
    '      depends_on: []',
    '      instructions: Draft the change.',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
    '    - id: review',
    '      kind: agent',
    '      role: missing-reviewer',
    '      mode: read',
    '      depends_on: [draft]',
    '      instructions: Review the change.',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
  ].join('\n'))
}

async function writeLegacyRole(
  rolesDir: string,
  roleId: string,
  systemPrompt: string,
): Promise<void> {
  await writeFile(path.join(rolesDir, `${roleId}.yaml`), [
    `role_id: ${roleId}`,
    `name: ${roleId}`,
    'version: 1.0.0',
    `description: ${roleId} role`,
    `system_prompt: ${systemPrompt}`,
    'execution:',
    '  harness: codex',
    '  keep_alive_after_task: false',
  ].join('\n'))
}
