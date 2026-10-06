import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkflowCompiler } from '@dsh/core'
import type { RoleDefinition, RoleProvider, RoleSummary } from '../src/role/types.js'
import { extractStepRoleIds } from '../src/workflow-skill/extract-role-ids.js'
import { FileWorkflowSkillProvider } from '../src/workflow-skill/file-provider.js'
import { resolveWorkflowRoles } from '../src/workflow-skill/role-resolver.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => {
    return rm(directory, { recursive: true, force: true })
  }))
})

describe('extractStepRoleIds', () => {
  it('extracts string role values and removes duplicates', () => {
    expect(extractStepRoleIds({
      spec: {
        steps: [
          { role: 'implementer' },
          { role: 'reviewer' },
          { role: 'implementer' },
          { role: 42 },
        ],
      },
    })).toEqual(['implementer', 'reviewer'])
  })

  it('returns an empty list for malformed or missing workflow steps', () => {
    const malformedValues: unknown[] = [
      null,
      'workflow',
      {},
      { spec: null },
      { spec: [] },
      { spec: { steps: null } },
      { spec: { steps: {} } },
      { spec: { steps: [null, 1, 'step', { role: {} }] } },
    ]

    for (const value of malformedValues) {
      expect(() => extractStepRoleIds(value)).not.toThrow()
      expect(extractStepRoleIds(value)).toEqual([])
    }
  })
})

describe('resolveWorkflowRoles', () => {
  it('uses a local role when no global role exists', async () => {
    const localRolesDir = await makeDirectory('local-roles-')
    await writeLegacyRole(localRolesDir, 'local-only', 'local prompt', '1.0.0')

    const result = await resolveWorkflowRoles({
      localRolesDir,
      requiredRoleIds: ['local-only'],
      globalRoles: new StaticRoleProvider([]),
    })

    expect(result.roles.get('local-only')?.systemPrompt).toBe('local prompt')
    expect(result.resolutions).toEqual([
      expect.objectContaining({
        roleId: 'local-only',
        source: 'local',
        shadowsGlobal: false,
      }),
    ])
    expect(result.failures).toEqual([])
  })

  it('falls back to a global role when no local role exists', async () => {
    const globalRole = role('global-only', 'global prompt', '2.0.0')
    const result = await resolveWorkflowRoles({
      localRolesDir: await makeDirectory('empty-local-'),
      requiredRoleIds: ['global-only'],
      globalRoles: new StaticRoleProvider([globalRole]),
    })

    expect(result.roles.get('global-only')).toBe(globalRole)
    expect(result.resolutions).toEqual([
      expect.objectContaining({ roleId: 'global-only', source: 'global', shadowsGlobal: false }),
    ])
  })

  it('keeps the local role and marks a same-id global role as shadowed', async () => {
    const localRolesDir = await makeDirectory('shadowing-local-')
    await writeLegacyRole(localRolesDir, 'shared', 'local prompt', '1.0.0')
    const globalRole = role('shared', 'global prompt', '2.0.0')

    const result = await resolveWorkflowRoles({
      localRolesDir,
      requiredRoleIds: ['shared'],
      globalRoles: new StaticRoleProvider([globalRole]),
    })

    expect(result.roles.get('shared')?.systemPrompt).toBe('local prompt')
    expect(result.roles.get('shared')?.version).toBe('1.0.0')
    expect(result.resolutions).toEqual([
      expect.objectContaining({ roleId: 'shared', source: 'local', shadowsGlobal: true }),
    ])
  })

  it('collects missing roles as failures without throwing', async () => {
    const result = await resolveWorkflowRoles({
      requiredRoleIds: ['missing'],
      globalRoles: new StaticRoleProvider([]),
    })

    expect(result.roles.size).toBe(0)
    expect(result.resolutions).toEqual([])
    expect(result.failures).toEqual([{
      roleId: 'missing',
      reason: '角色 "missing" 在本地和全局角色库中均未找到',
    }])
  })

  it('uses only the global provider when localRolesDir is undefined', async () => {
    const globalRole = role('global-only', 'global prompt', '1.0.0')
    const result = await resolveWorkflowRoles({
      requiredRoleIds: ['global-only'],
      globalRoles: new StaticRoleProvider([globalRole]),
    })

    expect(result.failures).toEqual([])
    expect(result.resolutions[0]).toMatchObject({ roleId: 'global-only', source: 'global' })
  })

  it('resolves a discovered Pack through extraction, role resolution, and compilation', async () => {
    const skillsDir = await makeDirectory('skills-')
    const packPath = path.join(skillsDir, 'local-workflow')
    const localRolesDir = path.join(packPath, 'dsh', 'roles')
    await mkdir(localRolesDir, { recursive: true })
    await writeFile(path.join(packPath, 'SKILL.md'), [
      '---',
      'name: Local workflow',
      'description: Workflow with a private role.',
      '---',
      'A test workflow.',
    ].join('\n'))
    await writeFile(path.join(packPath, 'dsh', 'pack.yaml'), [
      'dsh.kind: workflow',
      'dsh.apiVersion: dsh.orchestrator/v1alpha1',
      'dsh.entry: dsh/workflow.yaml',
      'dsh.workflowId: local-workflow',
    ].join('\n'))
    await writeFile(path.join(packPath, 'dsh', 'workflow.yaml'), compilerWorkflow('shared'))
    await writeLegacyRole(localRolesDir, 'shared', 'private prompt', '9.0.0')

    const discovered = await new FileWorkflowSkillProvider({ skillsDir }).get('local-workflow')
    expect(discovered).toBeDefined()
    const roleIds = extractStepRoleIds(discovered?.rawWorkflow)
    const resolved = await resolveWorkflowRoles({
      localRolesDir: discovered?.localRolesDir,
      requiredRoleIds: roleIds,
      globalRoles: new StaticRoleProvider([role('shared', 'global prompt', '1.0.0')]),
    })

    expect(resolved.failures).toEqual([])
    expect(resolved.resolutions[0]).toMatchObject({
      roleId: 'shared',
      source: 'local',
      shadowsGlobal: true,
    })
    const compiled = await new WorkflowCompiler().compile(discovered?.rawWorkflow, resolved.roles)
    expect(compiled.valid).toBe(true)
  })
})

class StaticRoleProvider implements RoleProvider {
  private readonly roles: Map<string, RoleDefinition>

  constructor(definitions: readonly RoleDefinition[]) {
    this.roles = new Map(definitions.map((definition) => [definition.roleId, definition]))
  }

  async get(roleId: string): Promise<RoleDefinition | undefined> {
    return this.roles.get(roleId)
  }

  async list(): Promise<RoleSummary[]> {
    return [...this.roles.values()].map((definition) => ({
      roleId: definition.roleId,
      name: definition.name,
      version: definition.version,
      harness: definition.execution.harness,
      keepAliveAfterTask: definition.execution.keepAliveAfterTask,
    }))
  }
}

function role(roleId: string, systemPrompt: string, version: string): RoleDefinition {
  return {
    roleId,
    name: roleId,
    version,
    description: `${roleId} role`,
    systemPrompt,
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

async function writeLegacyRole(
  rolesDir: string,
  roleId: string,
  systemPrompt: string,
  version: string,
): Promise<void> {
  await writeFile(path.join(rolesDir, `${roleId}.yaml`), [
    `role_id: ${roleId}`,
    `name: ${roleId}`,
    `version: ${version}`,
    `description: ${roleId} role`,
    `system_prompt: ${systemPrompt}`,
    'execution:',
    '  harness: codex',
    '  keep_alive_after_task: false',
  ].join('\n'))
}

function compilerWorkflow(roleId: string): string {
  return [
    'api_version: dsh.orchestrator/v1alpha1',
    'kind: Workflow',
    'metadata:',
    '  id: local-workflow',
    '  name: Local Workflow',
    '  description: Compile a local role workflow.',
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
    '    - id: implement',
    '      kind: agent',
    `      role: ${roleId}`,
    '      mode: read',
    '      depends_on: []',
    '      instructions: Implement the requested change.',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
  ].join('\n')
}
