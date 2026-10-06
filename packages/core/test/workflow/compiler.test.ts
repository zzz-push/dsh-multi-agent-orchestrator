import { describe, expect, it, vi } from 'vitest'

import type { RoleDefinition } from '@dsh/spec'

import { WorkflowCompiler } from '../../src/workflow/compiler.js'
import type { WorkflowFileResolver } from '../../src/workflow/types.js'

const compiler = new WorkflowCompiler()

function role(roleId: string, overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    roleId,
    name: roleId,
    version: '1.0.0',
    description: 'test role',
    systemPrompt: 'Follow the step instructions.',
    capabilities: [],
    execution: {
      harness: 'codex',
      keepAliveAfterTask: false,
      chatTimeoutMs: 600_000,
    },
    raw: {},
    ...overrides,
  }
}

function roles(): Map<string, RoleDefinition> {
  return new Map([
    ['implementer', role('implementer')],
    ['reviewer', role('reviewer')],
  ])
}

function validWorkflow(): Record<string, unknown> {
  return {
    api_version: 'dsh.orchestrator/v1alpha1',
    kind: 'Workflow',
    metadata: {
      id: 'feature-delivery',
      name: 'Feature Delivery',
      description: 'Implement and review a repository change.',
    },
    spec: {
      inputs: {
        task: { type: 'string', required: true, max_length: 12_000 },
      },
      execution: {
        max_parallel: 2,
        failure_mode: 'stop_after_batch',
        max_run_seconds: 7_200,
      },
      workspace: {
        strategy: 'git_worktree',
        dirty_policy: 'reject',
        merge_strategy: 'deterministic_cherry_pick',
        final_apply: 'approval_required',
      },
      budget: {
        max_total_tokens: 500_000,
        max_cost_usd: 15,
        on_unknown_price: 'require_approval',
      },
      steps: [
        {
          id: 'implement',
          kind: 'agent',
          role: 'implementer',
          mode: 'write',
          depends_on: [],
          instructions: 'Implement: ${{ inputs.task }} for ${{ run.id }} / ${{ step.id }}',
          paths: {
            allow_changes: ['src/**', 'tests/**'],
            deny_changes: ['.github/**'],
          },
          checks: [
            {
              id: 'unit-tests',
              command: ['pnpm', 'test'],
              timeout_seconds: 900,
            },
          ],
          policy: { timeout_seconds: 1_800, retries: 1 },
        },
        {
          id: 'review',
          kind: 'agent',
          role: 'reviewer',
          mode: 'read',
          depends_on: ['implement'],
          instructions: 'Review the accepted implementation.',
          consumes: [{ step: 'implement', artifacts: ['diff', 'checks', 'report'] }],
          policy: { timeout_seconds: 900, retries: 0 },
        },
      ],
    },
  }
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return value[key] as Record<string, unknown>
}

function stepsOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return recordAt(value, 'spec').steps as Array<Record<string, unknown>>
}

function paths(result: Awaited<ReturnType<WorkflowCompiler['compile']>>): string[] {
  return result.errors.map((error) => error.path)
}

describe('WorkflowCompiler', () => {
  it('compiles valid input into stable, deeply frozen canonical IR', async () => {
    const first = await compiler.compile(validWorkflow(), roles())
    const second = await compiler.compile(validWorkflow(), roles())

    expect(first.valid).toBe(true)
    expect(first.errors).toEqual([])
    expect(first.workflowHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.workflowHash).toBe(first.workflowHash)
    expect(first.ir?.spec.steps[0]).toMatchObject({
      instructions_file: null,
      instructions_file_content: null,
      consumes: [],
      policy: { repair_rounds: 0, approval_before_merge: false },
    })
    expect(first.ir?.spec.steps[0]?.checks[0]).toMatchObject({
      cwd: '.',
      env_allow: [],
      required: true,
    })
    expect(Object.isFrozen(first.ir)).toBe(true)
    expect(Object.isFrozen(first.ir?.spec.steps[0]?.checks)).toBe(true)
  })

  it('carries a step scenario into the IR and the run, and leaves steps without one unchanged', async () => {
    const plain = await compiler.compile(validWorkflow(), roles())
    const workflow = validWorkflow()
    stepsOf(workflow)[0]!.scenario = 'bug-fix'
    const withScenario = await compiler.compile(workflow, roles())

    expect(withScenario.valid).toBe(true)
    expect(withScenario.ir?.spec.steps[0]?.scenario).toBe('bug-fix')
    expect(withScenario.workflowHash).not.toBe(plain.workflowHash)
    // No `scenario` key at all when not declared: older workflows hash as before.
    expect('scenario' in (plain.ir?.spec.steps[0] ?? {})).toBe(false)
    const { createRunFromWorkflow } = await import('../../src/workflow/run-adapter.js')
    const run = createRunFromWorkflow({ ir: withScenario.ir!, workflowHash: withScenario.workflowHash!, repository: { root: '/repo', baseCommit: 'base' }, runId: 'run-s' })
    expect(Object.values(run.steps)[0]?.metadata?.scenario).toBe('bug-fix')

    // The Run carries the instructions as the agent will read them: inputs rendered in.
    const rendered = createRunFromWorkflow({ ir: withScenario.ir!, workflowHash: withScenario.workflowHash!, repository: { root: '/repo', baseCommit: 'base' }, runId: 'run-r', input: { task: 'add a --json flag' } })
    expect(rendered.steps.implement?.metadata?.instructions).toBe('Implement: add a --json flag for run-r / implement')
    expect(run.steps.implement?.metadata?.instructions).toBe('Implement:  for run-s / implement')

    stepsOf(workflow)[0]!.scenario = 'Not Valid'
    const invalid = await compiler.compile(workflow, roles())
    expect(invalid.valid).toBe(false)
    expect(paths(invalid)).toContain('/spec/steps/0/scenario')
  })

  it('compiles workspace setup commands into the IR and the run, and leaves workflows without them unchanged', async () => {
    const plain = await compiler.compile(validWorkflow(), roles())
    const workflow = validWorkflow()
    recordAt(recordAt(workflow, 'spec'), 'workspace').setup = [{ id: 'install', command: ['pnpm', 'install', '--offline'], timeout_seconds: 600 }]
    const compiled = await compiler.compile(workflow, roles())
    expect(compiled.valid).toBe(true)
    expect(compiled.ir?.spec.workspace.setup).toEqual([{ id: 'install', command: ['pnpm', 'install', '--offline'], cwd: '.', timeout_seconds: 600, env_allow: [], required: true }])
    expect('setup' in (plain.ir?.spec.workspace ?? {})).toBe(false)
    const { createRunFromWorkflow } = await import('../../src/workflow/run-adapter.js')
    const run = createRunFromWorkflow({ ir: compiled.ir!, workflowHash: compiled.workflowHash!, repository: { root: '/repo', baseCommit: 'base' }, runId: 'run-w' })
    expect(run.workflow?.setup).toEqual([{ id: 'install', command: ['pnpm', 'install', '--offline'], cwd: '.', timeoutSeconds: 600, envAllow: [], required: true }])

    recordAt(recordAt(workflow, 'spec'), 'workspace').setup = 'pnpm install'
    expect(paths(await compiler.compile(workflow, roles()))).toContain('/spec/workspace/setup')
  })

  it('lets a step\'s instructions and the workflow\'s inputs satisfy its role\'s required inputs', async () => {
    const withContract = (required: string[]) => role('implementer', { contract: { input: { required } } })
    const rolesWith = (required: string[]) => new Map([['implementer', withContract(required)], ['reviewer', role('reviewer')]])

    // task_description: the step's instructions are the task.
    expect((await compiler.compile(validWorkflow(), rolesWith(['task_description']))).valid).toBe(true)
    // A workflow input of the same name.
    const workflow = validWorkflow()
    recordAt(recordAt(workflow, 'spec'), 'inputs').handoff_document = { type: 'string', required: false }
    expect((await compiler.compile(workflow, rolesWith(['task_description', 'handoff_document']))).valid).toBe(true)
    // Nothing provides it: still an error, as before.
    const missing = await compiler.compile(validWorkflow(), rolesWith(['design_document']))
    expect(missing.valid).toBe(false)
    expect(missing.errors.map((error) => error.message)).toContain('步骤 "implement" 需要输入字段 "design_document"，但没有上游步骤能够提供')
  })

  it('injects instructions_file content and includes it in the hash', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) {
      delete step.instructions
      step.instructions_file = 'instructions/implement.md'
    }
    const resolver = (content: string): WorkflowFileResolver => ({
      readInstructionsFile: vi.fn().mockResolvedValue(content),
    })

    const first = await compiler.compile(workflow, roles(), resolver('first'))
    const second = await compiler.compile(workflow, roles(), resolver('second'))

    expect(first.valid).toBe(true)
    expect(first.ir?.spec.steps[0]?.instructions_file_content).toBe('first')
    expect(first.workflowHash).not.toBe(second.workflowHash)
  })

  it('warns when instructions_file checks cannot run without a resolver', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) {
      delete step.instructions
      step.instructions_file = 'instructions/implement.md'
    }

    const result = await compiler.compile(workflow, roles())

    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([
      {
        path: '/spec/steps/0/instructions_file',
        message: expect.stringContaining('fileResolver'),
      },
    ])
  })

  it('rejects a missing or unreadable instructions_file when a resolver is present', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) {
      delete step.instructions
      step.instructions_file = 'instructions/implement.md'
    }
    const missing: WorkflowFileResolver = {
      readInstructionsFile: vi.fn().mockResolvedValue(undefined),
    }
    const failed: WorkflowFileResolver = {
      readInstructionsFile: vi.fn().mockRejectedValue(new Error('adapter unavailable')),
    }

    expect(paths(await compiler.compile(workflow, roles(), missing))).toContain(
      '/spec/steps/0/instructions_file',
    )
    const failedResult = await compiler.compile(workflow, roles(), failed)
    expect(failedResult.errors).toContainEqual({
      path: '/spec/steps/0/instructions_file',
      message: expect.stringContaining('adapter unavailable'),
    })
  })

  it('rejects a non-object workflow', async () => {
    const result = await compiler.compile(null, roles())

    expect(result).toEqual({
      valid: false,
      errors: [{ path: '/', message: 'workflow 必须是对象' }],
      warnings: [],
    })
  })

  it('rejects schema mismatches and unknown top-level and spec fields', async () => {
    const workflow = validWorkflow()
    workflow.api_version = 'dsh.orchestrator/v2'
    workflow.kind = 'Pipeline'
    workflow.extra = true
    recordAt(workflow, 'spec').agents = []

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/api_version',
      '/kind',
      '/extra',
      '/spec/agents',
    ]))
  })

  it('rejects unknown nested fields and invalid input constraints', async () => {
    const workflow = validWorkflow()
    recordAt(workflow, 'metadata').display_name = 'unknown'
    const input = recordAt(recordAt(recordAt(workflow, 'spec'), 'inputs'), 'task')
    input.extra = true
    input.type = 'number'

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/metadata/display_name',
      '/spec/inputs/task/extra',
      '/spec/inputs/task/max_length',
    ]))
  })

  it('validates workflow and step identifiers and reports duplicate steps', async () => {
    const workflow = validWorkflow()
    recordAt(workflow, 'metadata').id = 'Invalid_ID'
    const steps = stepsOf(workflow)
    if (steps[0] && steps[1]) {
      steps[0].id = 'Bad_ID'
      steps[1].id = 'Bad_ID'
      steps[1].depends_on = []
      delete steps[1].consumes
    }

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/metadata/id',
      '/spec/steps/0/id',
      '/spec/steps/1/id',
    ]))
    expect(result.errors).toContainEqual({
      path: '/spec/steps/1/id',
      message: expect.stringContaining('重复'),
    })
  })

  it('reports a missing role at the referencing step', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[1]
    if (step) step.role = 'missing-role'

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/steps/1/role',
      message: '找不到角色定义: missing-role',
    })
  })

  it('reuses ContractChecker for incompatible role contracts', async () => {
    const roleMap = roles()
    roleMap.set('reviewer', role('reviewer', {
      contract: { input: { required: ['architecture'] } },
    }))

    const result = await compiler.compile(validWorkflow(), roleMap)

    expect(result.errors).toContainEqual({
      path: '/spec/steps/1/role',
      message: expect.stringContaining('architecture'),
    })
  })

  it('rejects unknown, self, duplicate, and non-dependent artifact references', async () => {
    const workflow = validWorkflow()
    const steps = stepsOf(workflow)
    if (steps[0]) steps[0].depends_on = ['missing', 'implement', 'missing']
    if (steps[1]) {
      steps[1].depends_on = []
      steps[1].consumes = [{ step: 'implement', artifacts: ['diff'] }]
    }

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/steps/0/depends_on/0',
      '/spec/steps/0/depends_on/1',
      '/spec/steps/0/depends_on/2',
      '/spec/steps/1/consumes/0/step',
    ]))
  })

  it('reports dependency cycles and steps unreachable from a root', async () => {
    const workflow = validWorkflow()
    const steps = stepsOf(workflow)
    if (steps[0] && steps[1]) {
      steps[0].depends_on = ['review']
      steps[1].depends_on = ['implement']
    }

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/steps/0/depends_on/0',
      message: '步骤依赖形成环',
    })
    expect(result.errors).toContainEqual({
      path: '/spec/steps/1/id',
      message: '步骤无法从可执行根节点到达',
    })
  })

  it('validates execution limits and fixed execution semantics', async () => {
    const workflow = validWorkflow()
    const execution = recordAt(recordAt(workflow, 'spec'), 'execution')
    execution.max_parallel = 0
    execution.max_run_seconds = -1
    execution.failure_mode = 'continue'

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/execution/max_parallel',
      '/spec/execution/max_run_seconds',
      '/spec/execution/failure_mode',
    ]))
  })

  it('validates workspace enum values', async () => {
    const workflow = validWorkflow()
    const workspace = recordAt(recordAt(workflow, 'spec'), 'workspace')
    workspace.strategy = 'shared'
    workspace.dirty_policy = 'allow'
    workspace.merge_strategy = 'merge'
    workspace.final_apply = 'automatic'

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/workspace/strategy',
      '/spec/workspace/dirty_policy',
      '/spec/workspace/merge_strategy',
      '/spec/workspace/final_apply',
    ]))
  })

  it('requires coherent positive token and non-negative cost budgets', async () => {
    const workflow = validWorkflow()
    const budget = recordAt(recordAt(workflow, 'spec'), 'budget')
    budget.max_total_tokens = 0
    budget.max_cost_usd = -1
    delete budget.on_unknown_price

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/budget/max_total_tokens',
      '/spec/budget/max_cost_usd',
      '/spec/budget/on_unknown_price',
    ]))
  })

  it('rejects approval for unknown pricing when no cost may be spent', async () => {
    const workflow = validWorkflow()
    recordAt(recordAt(workflow, 'spec'), 'budget').max_cost_usd = 0

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/budget/on_unknown_price',
      message: expect.stringContaining('max_cost_usd 为 0'),
    })
  })

  it('validates step timeout, retry, and repair ranges', async () => {
    const workflow = validWorkflow()
    const policy = recordAt(stepsOf(workflow)[0] ?? {}, 'policy')
    policy.timeout_seconds = 0
    policy.retries = -1
    policy.repair_rounds = 1.5
    policy.approval_before_merge = 'yes'

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/steps/0/policy/timeout_seconds',
      '/spec/steps/0/policy/retries',
      '/spec/steps/0/policy/repair_rounds',
      '/spec/steps/0/policy/approval_before_merge',
    ]))
  })

  it('requires write allow paths and validates all repository-relative paths', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) {
      step.paths = {
        allow_changes: [],
        deny_changes: ['../secrets/**', '/absolute/**', 'src\\windows'],
      }
      step.instructions_file = '../instructions.md'
      delete step.instructions
    }

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/steps/0/paths/allow_changes',
      '/spec/steps/0/paths/deny_changes/0',
      '/spec/steps/0/paths/deny_changes/1',
      '/spec/steps/0/paths/deny_changes/2',
      '/spec/steps/0/instructions_file',
    ]))
  })

  it('rejects simultaneous instruction sources', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) step.instructions_file = 'instructions/implement.md'

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/steps/0',
      message: expect.stringContaining('不能同时声明'),
    })
  })

  it('rejects undeclared, unsupported, and malformed template variables', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) {
      step.instructions = [
        '${{ inputs.missing }}',
        '${{ env.HOME }}',
        '${{ inputs.task ',
      ].join('\n')
    }

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/steps/0/instructions',
      message: '未声明的模板输入: missing',
    })
    expect(result.errors).toContainEqual({
      path: '/spec/steps/0/instructions',
      message: '不支持的模板变量: env.HOME',
    })
    expect(result.errors).toContainEqual({
      path: '/spec/steps/0/instructions',
      message: expect.stringContaining('结束标记'),
    })
  })

  it('validates check argv, timeout, env allow-list, and cwd', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    const check = step ? (step.checks as Array<Record<string, unknown>>)[0] : undefined
    if (check) {
      check.command = ['pnpm', '']
      check.timeout_seconds = 0
      check.env_allow = ['PATH', 1]
      check.cwd = '../outside'
    }

    const result = await compiler.compile(workflow, roles())

    expect(paths(result)).toEqual(expect.arrayContaining([
      '/spec/steps/0/checks/0/command/1',
      '/spec/steps/0/checks/0/timeout_seconds',
      '/spec/steps/0/checks/0/env_allow/1',
      '/spec/steps/0/checks/0/cwd',
    ]))
  })

  it('rejects empty check argv arrays at the command field', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    const check = step ? (step.checks as Array<Record<string, unknown>>)[0] : undefined
    if (check) check.command = []

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/spec/steps/0/checks/0/command',
      message: '数组不能为空',
    })
  })

  it('rejects a Canonical IR larger than 1 MiB', async () => {
    const workflow = validWorkflow()
    const step = stepsOf(workflow)[0]
    if (step) step.instructions = 'x'.repeat(1024 * 1024)

    const result = await compiler.compile(workflow, roles())

    expect(result.errors).toContainEqual({
      path: '/',
      message: '展开后的 Canonical IR 不能超过 1 MiB',
    })
  })
})
