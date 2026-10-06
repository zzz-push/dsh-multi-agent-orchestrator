import { describe, expect, it } from 'vitest'

import type { RoleDefinition } from '@dsh/spec'

import type {
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutor,
  CheckRequest,
  CheckResult,
  Clock,
  CreateAttemptWorkspace,
  MergeWorkspaceResult,
  VerificationDriver,
  WorkspaceDriver,
} from '../../src/ports.js'
import { InMemoryRunRepository } from '../../src/repository/in-memory.js'
import { Scheduler } from '../../src/scheduler/scheduler.js'
import { WorkflowCompiler } from '../../src/workflow/compiler.js'
import { createRunFromWorkflow } from '../../src/workflow/run-adapter.js'

class FakeAgentExecutor implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded' }) }
  }
}

class FakeWorkspaceDriver implements WorkspaceDriver {
  readonly removed: string[] = []

  async createAttempt(request: CreateAttemptWorkspace) {
    return {
      workspaceId: `ws-${request.stepId}-${request.attempt}`,
      worktreePath: `/tmp/${request.stepId}`,
    }
  }

  async captureResult() {
    return { resultCommit: 'captured-commit' }
  }

  async mergeResult(request: MergeWorkspaceResult) {
    return { merged: true, integrationCommit: request.resultCommit }
  }

  async removeAttempt(workspaceId: string) {
    this.removed.push(workspaceId)
  }
}

class FakeVerificationDriver implements VerificationDriver {
  async run(_check: CheckRequest): Promise<CheckResult> {
    return { passed: true, evidence: { passed: true } }
  }
}

function fixedClock(now: number): Clock {
  return { now: () => now }
}

function role(roleId: string): RoleDefinition {
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
  }
}

function workflow(): Record<string, unknown> {
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
          instructions: 'Implement: ${{ inputs.task }}',
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
          policy: {
            timeout_seconds: 1_800,
            repair_rounds: 1,
            retries: 1,
            approval_before_merge: true,
          },
        },
        {
          id: 'review',
          kind: 'agent',
          role: 'reviewer',
          mode: 'read',
          depends_on: ['implement'],
          instructions_file: 'instructions/review.md',
          consumes: [
            { step: 'implement', artifacts: ['diff', 'checks', 'report'] },
          ],
          policy: { timeout_seconds: 900, retries: 0 },
        },
      ],
    },
  }
}

describe('createRunFromWorkflow', () => {
  it('runs compiled workflow IR through dependent write and read steps', async () => {
    const roles = new Map([
      ['implementer', role('implementer')],
      ['reviewer', role('reviewer')],
    ])
    const compiled = await new WorkflowCompiler().compile(workflow(), roles, {
      readInstructionsFile: async (relativePath) => relativePath === 'instructions/review.md'
        ? 'Review the accepted implementation.'
        : undefined,
    })
    expect(compiled.valid).toBe(true)
    if (compiled.ir === undefined || compiled.workflowHash === undefined) {
      throw new Error('Expected workflow compilation to produce canonical IR')
    }

    const now = 10_000
    const run = createRunFromWorkflow({
      runId: 'run-from-workflow',
      ir: compiled.ir,
      workflowHash: compiled.workflowHash,
      repository: {
        root: '/repo',
        gitCommonDir: '/repo/.git',
        baseCommit: 'base-commit',
      },
      initiator: { kind: 'agent', sessionId: 'session-1' },
      input: { task: 'ship the flag' },
      now,
      idempotencyKey: 'workflow-request-1',
    })

    expect(run).toMatchObject({
      id: 'run-from-workflow',
      workflowId: 'feature-delivery',
      workflowHash: compiled.workflowHash,
      initiator: { kind: 'agent', sessionId: 'session-1' },
      repository: {
        root: '/repo',
        gitCommonDir: '/repo/.git',
        baseCommit: 'base-commit',
      },
      budget: { tokenLimit: 500_000, costLimit: 15 },
      workflow: {
        maxParallel: 2,
        failureMode: 'stop_after_batch',
        totalDeadlineAt: now + 7_200_000,
      },
      createdAt: now,
      updatedAt: now,
      idempotencyKey: 'workflow-request-1',
    })
    expect(run.workflow?.steps).toHaveLength(2)
    expect(run.steps.implement).toMatchObject({
      dependsOn: [],
      readOnly: false,
      requiresApproval: true,
      maxAttempts: 2,
    })
    expect(run.steps.implement?.metadata).toEqual({
      role: 'implementer',
      mode: 'write',
      // The mode decides the agent's sandbox; a read step would run read-only.
      sandbox: 'workspace-write',
      // Rendered at Run creation: what the agent will actually read.
      instructions: 'Implement: ship the flag',
      instructions_file: null,
      instructions_file_content: null,
      consumes: [],
      paths: {
        allow_changes: ['src/**', 'tests/**'],
        deny_changes: ['.github/**'],
      },
      checks: [
        {
          id: 'unit-tests',
          command: ['pnpm', 'test'],
          cwd: '.',
          timeout_seconds: 900,
          env_allow: [],
          required: true,
        },
      ],
      policy: {
        timeout_seconds: 1_800,
        repair_rounds: 1,
        retries: 1,
        approval_before_merge: true,
      },
    })
    expect(run.steps.review).toMatchObject({
      dependsOn: ['implement'],
      readOnly: true,
      requiresApproval: false,
      maxAttempts: 1,
      metadata: {
        role: 'reviewer',
        sandbox: 'read-only',
        instructions_file: 'instructions/review.md',
        instructions_file_content: 'Review the accepted implementation.',
      },
    })

    const repository = new InMemoryRunRepository()
    const agentExecutor = new FakeAgentExecutor()
    const scheduler = new Scheduler({
      repository,
      agentExecutor,
      workspaceDriver: new FakeWorkspaceDriver(),
      verificationDriver: new FakeVerificationDriver(),
      clock: fixedClock(now),
    })
    await repository.create(run)

    const result = await scheduler.run(run.id)

    expect(result.status).toBe('delivery_ready')
    expect(result.steps.implement?.status).toBe('merged')
    expect(result.steps.review?.status).toBe('succeeded')
    expect(result.steps.implement?.batch).toBe(1)
    expect(result.steps.review?.batch).toBe(2)
    expect(result.steps.review?.readOnly).toBe(true)
    expect(result.steps.review?.metadata?.role).toBe('reviewer')
    expect(agentExecutor.started.map((request) => request.stepId)).toEqual([
      'implement',
      'review',
    ])
  })
})
