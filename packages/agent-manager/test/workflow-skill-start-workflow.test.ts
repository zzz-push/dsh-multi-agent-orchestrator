import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  InMemoryRunRepository,
  Scheduler,
  type AgentExecutionHandle,
  type AgentExecutionRequest,
  type AgentExecutor,
  type CanonicalWorkflowInput,
  type RunAggregate,
} from '@dsh/core'

import type { RoleDefinition, RoleProvider, RoleSummary } from '../src/role/types.js'
import {
  startWorkflow,
  validateWorkflowInput,
} from '../src/workflow-skill/start-workflow.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => {
    return rm(directory, { recursive: true, force: true })
  }))
})

describe('validateWorkflowInput', () => {
  it('checks required string values, type, length, and JSON Pointer escaping', () => {
    const schema: Record<string, CanonicalWorkflowInput> = {
      'task/name': { type: 'string', required: true, max_length: 3 },
      optional: { type: 'string', required: false, max_length: null },
    }

    expect(validateWorkflowInput(schema, {})).toEqual([
      { path: '/spec/inputs/task~1name', message: '必填输入缺失' },
    ])
    expect(validateWorkflowInput(schema, { 'task/name': 1 })).toEqual([
      { path: '/spec/inputs/task~1name', message: '输入必须是字符串' },
    ])
    expect(validateWorkflowInput(schema, { 'task/name': 'four' })).toEqual([
      { path: '/spec/inputs/task~1name', message: '输入长度不能超过 3 个字符' },
    ])
    expect(validateWorkflowInput(schema, { 'task/name': 'ok' })).toEqual([])
  })
})

describe('startWorkflow', () => {
  it('discovers a disabled Pack, resolves its local role, persists the Run, and schedules it', async () => {
    const skillsDir = await makeDirectory('workflow-skills-')
    await writeWorkflowPack(skillsDir, { workflowId: 'local-flow' })

    const runRepository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({
      repository: runRepository,
      agentExecutor,
      clock: { now: () => 1_000 },
    })
    const runSpy = vi.spyOn(scheduler, 'run')

    const result = await startWorkflow({
      workflowId: 'local-flow',
      input: { task: 'ship' },
      skillsDir,
      globalRoles: new StaticRoleProvider([]),
      repository: { root: '/repository', baseCommit: 'base-commit' },
      scheduler,
      runRepository,
      runId: 'started-run',
      initiator: { kind: 'agent', sessionId: 'session-1' },
      now: 1_000,
      idempotencyKey: 'start-local-flow',
    })

    expect(result).toMatchObject({ outcome: 'started', runId: 'started-run' })
    expect(runSpy).toHaveBeenCalledWith('started-run')
    // A caller that wants the outcome can wait for it.
    expect((await (result as { settled: Promise<{ id: string; status: string }> }).settled)).toMatchObject({ id: 'started-run', status: 'delivery_ready' })
    expect(await runRepository.get('started-run')).toMatchObject({
      id: 'started-run',
      workflowId: 'local-flow',
      repository: { root: '/repository', baseCommit: 'base-commit' },
      initiator: { kind: 'agent', sessionId: 'session-1' },
      idempotencyKey: 'start-local-flow',
      createdAt: 1_000,
    })

    await vi.waitFor(async () => {
      const scheduled = await runRepository.get('started-run')
      expect(scheduled?.status).toBe('delivery_ready')
    })
    expect(agentExecutor.started.map((request) => request.stepId)).toEqual(['execute'])
  })

  it('returns workflow_not_found without creating or scheduling a Run', async () => {
    const skillsDir = await makeDirectory('workflow-skills-')
    const runRepository = new InMemoryRunRepository()
    const scheduler = recordingScheduler()

    const result = await startWorkflow(baseOptions({
      workflowId: 'missing-flow',
      input: {},
      skillsDir,
      scheduler,
      runRepository,
    }))

    expect(result).toEqual({ outcome: 'workflow_not_found' })
    expect(await runRepository.list()).toEqual([])
    expect(scheduler.run).not.toHaveBeenCalled()
  })

  it('returns compiler diagnostics for a Pack with a cyclic workflow graph', async () => {
    const skillsDir = await makeDirectory('workflow-skills-')
    await writeWorkflowPack(skillsDir, {
      workflowId: 'cyclic-flow',
      workflowSource: cyclicWorkflowSource('local-worker'),
    })
    const runRepository = new InMemoryRunRepository()
    const scheduler = recordingScheduler()

    const result = await startWorkflow(baseOptions({
      workflowId: 'cyclic-flow',
      input: { task: 'ok' },
      skillsDir,
      scheduler,
      runRepository,
    }))

    expect(result.outcome).toBe('compile_failed')
    if (result.outcome === 'compile_failed') {
      expect(result.errors).toContainEqual({
        path: '/spec/steps/0/depends_on/0',
        message: '步骤依赖形成环',
      })
    }
    expect(await runRepository.list()).toEqual([])
    expect(scheduler.run).not.toHaveBeenCalled()
  })

  it('rejects a missing required input before creating or scheduling a Run', async () => {
    const context = await invalidInputContext()

    const result = await startWorkflow(baseOptions({ ...context, input: {} }))

    expectInvalidTaskInput(result, '必填输入缺失')
    expect(await context.runRepository.list()).toEqual([])
    expect(context.scheduler.run).not.toHaveBeenCalled()
  })

  it('rejects an input with the wrong string type before creating or scheduling a Run', async () => {
    const context = await invalidInputContext()

    const result = await startWorkflow(baseOptions({ ...context, input: { task: 42 } }))

    expectInvalidTaskInput(result, '输入必须是字符串')
    expect(await context.runRepository.list()).toEqual([])
    expect(context.scheduler.run).not.toHaveBeenCalled()
  })

  it('rejects an input longer than max_length before creating or scheduling a Run', async () => {
    const context = await invalidInputContext()

    const result = await startWorkflow(baseOptions({ ...context, input: { task: 'toolong' } }))

    expectInvalidTaskInput(result, '输入长度不能超过 5 个字符')
    expect(await context.runRepository.list()).toEqual([])
    expect(context.scheduler.run).not.toHaveBeenCalled()
  })

  it('reports an unresolved role as a compile failure', async () => {
    const skillsDir = await makeDirectory('workflow-skills-')
    await writeWorkflowPack(skillsDir, {
      workflowId: 'missing-role-flow',
      roleId: 'missing-role',
      writeLocalRole: false,
    })
    const runRepository = new InMemoryRunRepository()
    const scheduler = recordingScheduler()

    const result = await startWorkflow(baseOptions({
      workflowId: 'missing-role-flow',
      input: { task: 'ok' },
      skillsDir,
      scheduler,
      runRepository,
    }))

    expect(result.outcome).toBe('compile_failed')
    if (result.outcome === 'compile_failed') {
      expect(result.errors).toContainEqual({
        path: '/spec/steps/0/role',
        message: '找不到角色定义: missing-role',
      })
    }
    expect(await runRepository.list()).toEqual([])
    expect(scheduler.run).not.toHaveBeenCalled()
  })

  it('returns before a slow Scheduler Run completes', async () => {
    const skillsDir = await makeDirectory('workflow-skills-')
    await writeWorkflowPack(skillsDir, { workflowId: 'slow-flow' })
    const runRepository = new InMemoryRunRepository()
    let resolveScheduling!: () => void
    const schedulingFinished = new Promise<void>((resolve) => {
      resolveScheduling = resolve
    })
    const scheduler = {
      run: vi.fn(async (runId: string): Promise<RunAggregate> => {
        await delay(250)
        resolveScheduling()
        const run = await runRepository.get(runId)
        if (run === undefined) throw new Error(`Expected persisted Run ${runId}`)
        return run
      }),
    } as unknown as Scheduler

    const startedAt = performance.now()
    const result = await startWorkflow(baseOptions({
      workflowId: 'slow-flow',
      input: { task: 'ok' },
      skillsDir,
      scheduler,
      runRepository,
      runId: 'slow-run',
    }))
    const elapsedMs = performance.now() - startedAt

    expect(result).toMatchObject({ outcome: 'started', runId: 'slow-run' })
    expect(scheduler.run).toHaveBeenCalledWith('slow-run')
    expect(elapsedMs).toBeLessThan(150)
    await schedulingFinished
  })
})

class FakeAgentExecutor implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded' }) }
  }
}

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

function recordingScheduler(): Scheduler & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (): Promise<RunAggregate> => ({}) as RunAggregate),
  } as unknown as Scheduler & { run: ReturnType<typeof vi.fn> }
}

function baseOptions(overrides: {
  workflowId: string
  input: Record<string, unknown>
  skillsDir: string
  scheduler: Scheduler
  runRepository: InMemoryRunRepository
  runId?: string
}) {
  return {
    workflowId: overrides.workflowId,
    input: overrides.input,
    skillsDir: overrides.skillsDir,
    globalRoles: new StaticRoleProvider([]),
    repository: { root: '/repository', baseCommit: 'base-commit' },
    scheduler: overrides.scheduler,
    runRepository: overrides.runRepository,
    runId: overrides.runId,
  }
}

async function invalidInputContext() {
  const skillsDir = await makeDirectory('workflow-skills-')
  await writeWorkflowPack(skillsDir, { workflowId: 'input-flow' })
  const runRepository = new InMemoryRunRepository()
  const scheduler = recordingScheduler()
  return { skillsDir, runRepository, scheduler, workflowId: 'input-flow' }
}

function expectInvalidTaskInput(
  result: Awaited<ReturnType<typeof startWorkflow>>,
  message: string,
): void {
  expect(result).toEqual({
    outcome: 'invalid_input',
    errors: [{ path: '/spec/inputs/task', message }],
  })
}

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `dsh-${prefix}`))
  temporaryDirectories.push(directory)
  return directory
}

interface WorkflowPackFixture {
  workflowId: string
  roleId?: string
  workflowSource?: string
  writeLocalRole?: boolean
  disableModelInvocation?: boolean
}

async function writeWorkflowPack(
  skillsDir: string,
  fixture: WorkflowPackFixture,
): Promise<void> {
  const packPath = path.join(skillsDir, fixture.workflowId)
  const roleId = fixture.roleId ?? 'local-worker'
  await mkdir(path.join(packPath, 'dsh'), { recursive: true })
  await writeFile(path.join(packPath, 'SKILL.md'), [
    '---',
    `name: ${fixture.workflowId}`,
    `description: Run ${fixture.workflowId}.`,
    `disable-model-invocation: ${fixture.disableModelInvocation ?? true}`,
    '---',
    'Workflow test Pack.',
  ].join('\n'))
  await writeFile(path.join(packPath, 'dsh', 'pack.yaml'), [
    'dsh.kind: workflow',
    'dsh.apiVersion: dsh.orchestrator/v1alpha1',
    'dsh.entry: dsh/workflow.yaml',
    `dsh.workflowId: ${fixture.workflowId}`,
  ].join('\n'))
  await writeFile(
    path.join(packPath, 'dsh', 'workflow.yaml'),
    fixture.workflowSource ?? validWorkflowSource(fixture.workflowId, roleId),
  )

  if (fixture.writeLocalRole === false) return
  const localRolesDir = path.join(packPath, 'dsh', 'roles')
  await mkdir(localRolesDir, { recursive: true })
  await writeFile(path.join(localRolesDir, `${roleId}.yaml`), [
    `role_id: ${roleId}`,
    `name: ${roleId}`,
    'version: 1.0.0',
    `description: ${roleId} role`,
    'system_prompt: Follow the workflow instructions.',
    'execution:',
    '  harness: codex',
    '  keep_alive_after_task: false',
  ].join('\n'))
}

function validWorkflowSource(workflowId: string, roleId: string): string {
  return [
    'api_version: dsh.orchestrator/v1alpha1',
    'kind: Workflow',
    'metadata:',
    `  id: ${workflowId}`,
    `  name: ${workflowId}`,
    '  description: Start a workflow test Run.',
    'spec:',
    '  inputs:',
    '    task:',
    '      type: string',
    '      required: true',
    '      max_length: 5',
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
    '    - id: execute',
    '      kind: agent',
    `      role: ${roleId}`,
    '      mode: read',
    '      depends_on: []',
    '      instructions: "Run: ${{ inputs.task }}"',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
  ].join('\n')
}

function cyclicWorkflowSource(roleId: string): string {
  return [
    'api_version: dsh.orchestrator/v1alpha1',
    'kind: Workflow',
    'metadata:',
    '  id: cyclic-flow',
    '  name: Cyclic Flow',
    'spec:',
    '  inputs:',
    '    task:',
    '      type: string',
    '      required: true',
    '      max_length: 5',
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
    '    - id: first',
    '      kind: agent',
    `      role: ${roleId}`,
    '      mode: read',
    '      depends_on: [second]',
    '      instructions: First.',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
    '    - id: second',
    '      kind: agent',
    `      role: ${roleId}`,
    '      mode: read',
    '      depends_on: [first]',
    '      instructions: Second.',
    '      policy:',
    '        timeout_seconds: 300',
    '        retries: 0',
  ].join('\n')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
