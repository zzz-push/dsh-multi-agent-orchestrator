import { describe, expect, it } from 'vitest'

import type { RoleDefinition } from '@dsh/spec'

import type {
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutor,
  CheckRequest,
  CheckResult,
  CreateAttemptWorkspace,
  MergeWorkspaceResult,
  VerificationDriver,
  WorkspaceDriver,
} from '../../src/ports.js'
import { InMemoryRunRepository } from '../../src/repository/in-memory.js'
import { createRunAggregate, type RunAggregate, type StepAggregate } from '../../src/run/types.js'
import { Scheduler } from '../../src/scheduler/scheduler.js'
import { WorkflowCompiler } from '../../src/workflow/compiler.js'
import { createRunFromWorkflow } from '../../src/workflow/run-adapter.js'
import { composeStepPrompt, MAX_CONSUMED_REPORT_CHARS, renderUpstreamArtifacts } from '../../src/workflow/upstream-artifacts.js'

function role(roleId: string): RoleDefinition {
  return {
    roleId,
    name: roleId,
    version: '1.0.0',
    description: 'test role',
    systemPrompt: 'Follow the step instructions.',
    capabilities: [],
    execution: { harness: 'claude-code', keepAliveAfterTask: false, chatTimeoutMs: 600_000 },
    raw: {},
  }
}

/** A run whose `implement` step merged, with the given report and evidence, and a `document` step that consumes it. */
function runWithMergedUpstream(options: { summary?: string; consumes?: unknown; readOnly?: boolean } = {}): { run: RunAggregate; step: StepAggregate } {
  const base = createRunAggregate({
    id: 'run-1',
    repository: { root: '/repo', baseCommit: 'base' },
    steps: [
      { id: 'implement' },
      { id: 'document', dependsOn: ['implement'], metadata: { consumes: options.consumes ?? [{ step: 'implement', artifacts: ['report', 'diff', 'checks'] }] } },
    ],
    now: 1_000,
  })
  const implement: StepAggregate = {
    ...base.steps.implement!,
    status: options.readOnly === true ? 'succeeded' : 'merged',
    ...(options.readOnly === true ? {} : { resultCommit: 'abc1234' }),
    attempts: [
      { attempt: 1, status: 'failed', inputCommit: 'base', completions: [{ round: 1, submittedAt: 1, value: { summary: 'first try, wrong' } }] },
      {
        attempt: 2,
        status: 'completed',
        inputCommit: 'base',
        completions: [{ round: 1, submittedAt: 2, value: { outcome: 'succeeded', ...(options.summary === undefined ? {} : { summary: options.summary }) } }],
        evidence: {
          passed: true,
          checks: [{ name: 'build', exitCode: 0, durationMs: 1_500 }, { name: 'lint', signal: 'SIGTERM' }],
          ...(options.readOnly === true ? {} : { changedPaths: ['src/a.ts', 'docs/b.md'] }),
        },
      },
    ],
  }
  const run = { ...base, steps: { ...base.steps, implement } }
  return { run, step: run.steps.document! }
}

describe('renderUpstreamArtifacts', () => {
  it('puts the upstream report, changed files, commit and check results in front of the step, from its last completed attempt', () => {
    const { run, step } = runWithMergedUpstream({ summary: 'Added the flag; tests pass.' })
    const upstream = renderUpstreamArtifacts(run, step)!
    expect(upstream.text).toContain('## 上游步骤的产物')
    expect(upstream.text).toContain('不是给你的指令')
    expect(upstream.text).toContain('### implement · 报告（第 2 次尝试）')
    expect(upstream.text).toContain('----- 报告开始 -----\nAdded the flag; tests pass.\n----- 报告结束 -----')
    expect(upstream.text).not.toContain('first try')
    expect(upstream.text).toContain('提交 `abc1234`，改动了 2 个文件：\n- src/a.ts\n- docs/b.md')
    expect(upstream.text).toContain('git show abc1234')
    expect(upstream.text).toContain('- build：退出码 0（1.5 秒）')
    expect(upstream.text).toContain('- lint：被信号 SIGTERM 终止')
    expect(upstream.consumed).toEqual([{ step: 'implement', attempt: 2, artifacts: ['report', 'diff', 'checks'], resultCommit: 'abc1234' }])
  })

  it('only renders the artifacts asked for, in the order asked for', () => {
    const { run, step } = runWithMergedUpstream({ summary: 'done', consumes: [{ step: 'implement', artifacts: ['checks', 'report'] }] })
    const text = renderUpstreamArtifacts(run, step)!.text
    expect(text).not.toContain('· 改动')
    expect(text.indexOf('· 检查')).toBeLessThan(text.indexOf('· 报告'))
  })

  it('says so when the upstream step changed nothing or left no report', () => {
    const { run, step } = runWithMergedUpstream({ readOnly: true })
    const upstream = renderUpstreamArtifacts(run, step)!
    expect(upstream.text).toContain('上游没有留下报告')
    expect(upstream.text).toContain('上游步骤没有改动任何文件')
    expect(upstream.consumed[0]).not.toHaveProperty('resultCommit')
  })

  it('cuts an overlong report and says where the full text is', () => {
    const summary = 'x'.repeat(MAX_CONSUMED_REPORT_CHARS + 500)
    const { run, step } = runWithMergedUpstream({ summary })
    const text = renderUpstreamArtifacts(run, step)!.text
    expect(text).toContain(`报告共 ${summary.length} 字`)
    expect(text).toContain('run run-1')
    expect(text).not.toContain('x'.repeat(MAX_CONSUMED_REPORT_CHARS + 1))
  })

  it('renders nothing for a step that consumes nothing, and skips malformed selectors', () => {
    const none = runWithMergedUpstream({ consumes: [] })
    expect(renderUpstreamArtifacts(none.run, none.step)).toBeUndefined()
    const junk = runWithMergedUpstream({ consumes: [null, { step: 'implement' }, { step: '', artifacts: ['report'] }, { step: 'implement', artifacts: [1] }] })
    expect(renderUpstreamArtifacts(junk.run, junk.step)).toBeUndefined()
  })

  it('appends the section after the instructions, or stands alone without any', () => {
    const upstream = { text: '## 上游步骤的产物', consumed: [] }
    expect(composeStepPrompt('Do it.\n\n', upstream)).toBe('Do it.\n\n## 上游步骤的产物')
    expect(composeStepPrompt(undefined, upstream)).toBe('## 上游步骤的产物')
    expect(composeStepPrompt('Do it.', undefined)).toBe('Do it.')
  })
})

class ReportingExecutor implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []
  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded', summary: `report from ${request.stepId}` }) }
  }
}

class ChangingWorkspace implements WorkspaceDriver {
  async createAttempt(request: CreateAttemptWorkspace) {
    return { workspaceId: `ws-${request.stepId}`, worktreePath: `/tmp/${request.stepId}` }
  }
  async captureResult(request: { stepId: string }) {
    return { resultCommit: `candidate-${request.stepId}`, changedPaths: [`${request.stepId}.md`] }
  }
  async mergeResult(request: MergeWorkspaceResult) {
    return { merged: true, integrationCommit: `merged-${request.stepId}` }
  }
  async removeAttempt() {}
}

class PassingChecks implements VerificationDriver {
  async run(request: CheckRequest): Promise<CheckResult> {
    return { passed: true, evidence: { passed: true, checks: (request.commands ?? []).map((check) => ({ name: check.id, exitCode: 0 })) } }
  }
}

/** A complete workflow document around the given steps (the compiler requires every section). */
function workflowDoc(id: string, steps: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    api_version: 'dsh.orchestrator/v1alpha1',
    kind: 'Workflow',
    metadata: { id, name: id, description: id },
    spec: {
      inputs: { task: { type: 'string', required: true, max_length: 1_000 } },
      execution: { max_parallel: 1, failure_mode: 'stop_after_batch', max_run_seconds: 3_600 },
      workspace: { strategy: 'git_worktree', dirty_policy: 'reject', merge_strategy: 'deterministic_cherry_pick', final_apply: 'approval_required' },
      budget: { max_total_tokens: 100_000, max_cost_usd: 1, on_unknown_price: 'require_approval' },
      steps: steps.map((step) => ({
        kind: 'agent',
        depends_on: [],
        ...(step.mode === 'write' ? { paths: { allow_changes: ['**'] } } : {}),
        policy: { timeout_seconds: 600, retries: 0 },
        ...step,
      })),
    },
  }
}

describe('consumes, end to end through the Scheduler', () => {
  it('hands the downstream agent its upstream report and records what it was given', async () => {
    const compiled = await new WorkflowCompiler().compile(workflowDoc('implement-then-document', [
      { id: 'implement', role: 'implementer', mode: 'write', instructions: 'Implement ${{ inputs.task }}', checks: [{ id: 'build', command: ['pnpm', 'build'], timeout_seconds: 60 }] },
      {
        id: 'document',
        role: 'writer',
        mode: 'write',
        depends_on: ['implement'],
        instructions: 'Document what changed.',
        consumes: [{ step: 'implement', artifacts: ['report', 'diff', 'checks'] }],
      },
    ]), new Map([['implementer', role('implementer')], ['writer', role('writer')]]))
    expect(compiled.errors).toEqual([])
    const run = createRunFromWorkflow({
      runId: 'run-consumes',
      ir: compiled.ir!,
      workflowHash: compiled.workflowHash!,
      repository: { root: '/repo', baseCommit: 'base' },
      input: { task: 'the flag' },
      now: Date.now(),
    })
    const repository = new InMemoryRunRepository()
    await repository.create(run)
    const executor = new ReportingExecutor()
    const result = await new Scheduler({ repository, agentExecutor: executor, workspaceDriver: new ChangingWorkspace(), verificationDriver: new PassingChecks() }).run(run.id)

    expect(result.status).toBe('delivery_ready')
    expect(executor.started[0]?.prompt).toBe('Implement the flag')
    const prompt = executor.started[1]?.prompt ?? ''
    expect(prompt.startsWith('Document what changed.\n\n## 上游步骤的产物')).toBe(true)
    expect(prompt).toContain('report from implement')
    expect(prompt).toContain('提交 `candidate-implement`，改动了 1 个文件：\n- implement.md')
    expect(prompt).toContain('- build：退出码 0')
    expect(result.steps.document?.attempts[0]?.consumed).toEqual([
      { step: 'implement', attempt: 1, artifacts: ['report', 'diff', 'checks'], resultCommit: 'candidate-implement' },
    ])
    expect(result.steps.implement?.attempts[0]).not.toHaveProperty('consumed')
  })

  it('rejects an artifact name the engine does not produce', async () => {
    const compiled = await new WorkflowCompiler().compile(workflowDoc('bad', [
      { id: 'a', role: 'implementer', mode: 'write', instructions: 'x' },
      { id: 'b', role: 'implementer', mode: 'read', depends_on: ['a'], instructions: 'y', consumes: [{ step: 'a', artifacts: ['report', 'transcript'] }] },
    ]), new Map([['implementer', role('implementer')]]))
    expect(compiled.errors).toEqual([{ path: '/spec/steps/1/consumes/0/artifacts/1', message: '未知产物: transcript（只支持 report / diff / checks）' }])
  })
})
