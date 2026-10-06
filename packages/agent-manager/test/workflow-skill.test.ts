import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkflowCompiler } from '@dsh/core'
import { InvalidWorkflowSkillError } from '../src/errors.js'
import type { RoleDefinition } from '../src/role/types.js'
import { FileWorkflowSkillProvider } from '../src/workflow-skill/file-provider.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface PackFixture {
  directory?: string
  kind?: string
  workflowId?: string
  entry?: string
  version?: string
  name?: string
  description?: string
  disableModelInvocation?: boolean
  skillSource?: string
  workflowSource?: string
  createEntry?: boolean
  createLocalRoles?: boolean
}

describe('FileWorkflowSkillProvider', () => {
  it('lists only valid workflow Packs and preserves discovery metadata', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, {
      directory: 'feature-pack',
      workflowId: 'feature-delivery',
      entry: 'workflows/feature.yaml',
      version: '1.2.3',
      name: 'Feature Delivery',
      description: 'Implement and verify a feature.',
      disableModelInvocation: false,
    })
    await writePack(skillsDir, { directory: 'role-pack', kind: 'role' })
    await writePack(skillsDir, { directory: 'untyped-pack', kind: '' })
    await writeFile(path.join(skillsDir, 'README.md'), 'not a directory')

    const provider = new FileWorkflowSkillProvider({ skillsDir })

    expect(await provider.list()).toEqual([
      {
        workflowId: 'feature-delivery',
        name: 'Feature Delivery',
        description: 'Implement and verify a feature.',
        disableModelInvocation: false,
        version: '1.2.3',
      },
    ])
    expect(await provider.get('feature-delivery')).toMatchObject({
      workflowId: 'feature-delivery',
      packPath: path.join(skillsDir, 'feature-pack'),
      rawWorkflow: { workflow: 'feature-delivery' },
      rawManifest: {
        'dsh.kind': 'workflow',
        'dsh.apiVersion': 'dsh.orchestrator/v1alpha1',
        'dsh.entry': 'workflows/feature.yaml',
        'dsh.workflowId': 'feature-delivery',
        'dsh.version': '1.2.3',
      },
    })
  })

  it('defaults model invocation to disabled and reports an existing local roles directory', async () => {
    const skillsDir = await makeSkillsDir()
    const packPath = await writePack(skillsDir, {
      directory: 'local-role-workflow',
      workflowId: 'local-role-workflow',
      createLocalRoles: true,
      skillSource: [
        '---',
        'name: Local Role Workflow',
        'description: Uses private roles.',
        '---',
        'Human-readable content.',
      ].join('\n'),
    })

    const skill = await new FileWorkflowSkillProvider({ skillsDir }).get('local-role-workflow')

    expect(skill?.disableModelInvocation).toBe(true)
    expect(skill?.localRolesDir).toBe(path.join(packPath, 'dsh', 'roles'))
  })

  it('warns and skips incomplete Packs during list()', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'healthy' })
    await writePack(skillsDir, {
      workflowId: 'missing-entry',
      createEntry: false,
    })
    await writePack(skillsDir, {
      workflowId: 'broken-skill',
      skillSource: 'name: no-frontmatter',
    })
    const warn = vi.fn<(message: string) => void>()
    const provider = new FileWorkflowSkillProvider({ skillsDir, logger: { warn } })

    expect(await provider.list()).toEqual([
      expect.objectContaining({ workflowId: 'healthy' }),
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      expect.stringContaining('missing-entry'),
      expect.stringContaining('broken-skill'),
    ]))
  })

  it('passes over an ordinary Skill (no dsh/pack.yaml) in list() without a warning', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'healthy' })
    await mkdir(path.join(skillsDir, 'authoring-guide'), { recursive: true })
    await writeFile(path.join(skillsDir, 'authoring-guide', 'SKILL.md'), '---\nname: authoring-guide\ndescription: how to write roles\n---\n')
    const warn = vi.fn<(message: string) => void>()
    const provider = new FileWorkflowSkillProvider({ skillsDir, logger: { warn } })

    expect(await provider.list()).toEqual([expect.objectContaining({ workflowId: 'healthy' })])
    expect(warn).not.toHaveBeenCalled()
  })

  it('throws a clear error when get() targets an invalid Pack', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'broken', createEntry: false })
    const provider = new FileWorkflowSkillProvider({ skillsDir })

    await expect(provider.get('broken')).rejects.toMatchObject({
      name: 'InvalidWorkflowSkillError',
      code: 'invalid-workflow-skill',
      details: { packPath: path.join(skillsDir, 'broken') },
    })
    await expect(provider.get('broken')).rejects.toThrow('cannot resolve dsh.entry')
  })

  it('returns undefined when no Pack declares the requested workflow id', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'known' })
    await writePack(skillsDir, {
      directory: 'unrelated-malformed-manifest',
      workflowId: 'ignored',
    })
    await writeFile(
      path.join(skillsDir, 'unrelated-malformed-manifest', 'dsh', 'pack.yaml'),
      'dsh.kind: [broken',
    )

    await expect(new FileWorkflowSkillProvider({ skillsDir }).get('unknown')).resolves
      .toBeUndefined()
  })

  it('attributes a malformed manifest to a matching Pack directory in get()', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'broken-manifest' })
    await writeFile(
      path.join(skillsDir, 'broken-manifest', 'dsh', 'pack.yaml'),
      'dsh.kind: [broken',
    )

    await expect(new FileWorkflowSkillProvider({ skillsDir }).get('broken-manifest'))
      .rejects.toBeInstanceOf(InvalidWorkflowSkillError)
  })

  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
  ])('rejects a %s entry while preserving list/get error semantics', async (_, entry) => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, { workflowId: 'escaping', entry, createEntry: false })
    const warn = vi.fn<(message: string) => void>()
    const provider = new FileWorkflowSkillProvider({ skillsDir, logger: { warn } })

    await expect(provider.list()).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('normalized relative POSIX path'))
    await expect(provider.get('escaping')).rejects.toThrow('normalized relative POSIX path')
  })

  it('returns empty results when the skills directory does not exist', async () => {
    const root = await makeSkillsDir()
    const provider = new FileWorkflowSkillProvider({
      skillsDir: path.join(root, 'missing'),
    })

    await expect(provider.list()).resolves.toEqual([])
    await expect(provider.get('unknown')).resolves.toBeUndefined()
  })

  it('loads an on-disk Pack into input accepted by WorkflowCompiler', async () => {
    const skillsDir = await makeSkillsDir()
    await writePack(skillsDir, {
      workflowId: 'implementation-flow',
      workflowSource: validCompilerWorkflow('example-role'),
    })
    const discovered = await new FileWorkflowSkillProvider({ skillsDir })
      .get('implementation-flow')
    expect(discovered).toBeDefined()

    const role: RoleDefinition = {
      roleId: 'example-role',
      name: 'Example Role',
      version: '1.0.0',
      description: 'A reusable example role',
      systemPrompt: 'Complete the requested task.',
      capabilities: [],
      execution: { harness: 'codex', keepAliveAfterTask: false, chatTimeoutMs: 600_000 },
      raw: {},
    }
    const roles = new Map([[role.roleId, role]])

    const compiled = await new WorkflowCompiler().compile(discovered?.rawWorkflow, roles)

    expect(compiled.valid).toBe(true)
    expect(compiled.ir?.metadata.id).toBe('implementation-flow')
  })
})

async function makeSkillsDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-skills-'))
  dirs.push(directory)
  return directory
}

async function writePack(skillsDir: string, fixture: PackFixture): Promise<string> {
  const workflowId = fixture.workflowId ?? 'workflow-pack'
  const packPath = path.join(skillsDir, fixture.directory ?? workflowId)
  const entry = fixture.entry ?? 'dsh/workflow.yaml'
  await mkdir(path.join(packPath, 'dsh'), { recursive: true })

  const kindLine = fixture.kind === '' ? '' : `dsh.kind: ${fixture.kind ?? 'workflow'}`
  await writeFile(path.join(packPath, 'dsh', 'pack.yaml'), [
    kindLine,
    'dsh.apiVersion: dsh.orchestrator/v1alpha1',
    `dsh.entry: ${entry}`,
    `dsh.workflowId: ${workflowId}`,
    fixture.version === undefined ? '' : `dsh.version: ${fixture.version}`,
  ].filter(Boolean).join('\n'))

  if (fixture.kind === undefined || fixture.kind === 'workflow') {
    const skillSource = fixture.skillSource ?? [
      '---',
      `name: ${fixture.name ?? workflowId}`,
      `description: ${fixture.description ?? `Run ${workflowId}.`}`,
      `disable-model-invocation: ${fixture.disableModelInvocation ?? true}`,
      '---',
      'Human-readable content.',
    ].join('\n')
    await writeFile(path.join(packPath, 'SKILL.md'), skillSource)
  }

  if (fixture.createEntry !== false && isSafeFixtureEntry(entry)) {
    const entryPath = path.join(packPath, entry)
    await mkdir(path.dirname(entryPath), { recursive: true })
    await writeFile(entryPath, fixture.workflowSource ?? `workflow: ${workflowId}\n`)
  }
  if (fixture.createLocalRoles) {
    await mkdir(path.join(packPath, 'dsh', 'roles'), { recursive: true })
  }
  return packPath
}

function isSafeFixtureEntry(entry: string): boolean {
  const resolved = path.resolve('/fixture-pack', entry)
  return resolved.startsWith('/fixture-pack/')
}

function validCompilerWorkflow(roleId: string): string {
  return [
    'api_version: dsh.orchestrator/v1alpha1',
    'kind: Workflow',
    'metadata:',
    '  id: implementation-flow',
    '  name: Implementation Flow',
    '  description: Compile a discovered workflow.',
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
