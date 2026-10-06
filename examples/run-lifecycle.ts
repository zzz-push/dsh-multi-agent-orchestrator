import {
  InMemoryRunRepository,
  Scheduler,
  createRunAggregate,
  requestCancellation,
  type AgentExecutionHandle,
  type AgentExecutionRequest,
  type AgentExecutor,
  type CheckRequest,
  type CheckResult,
  type CreateAttemptWorkspace,
  type MergeWorkspaceResult,
  type StepDefinition,
  type VerificationDriver,
  type WorkspaceDriver,
} from '@dsh/core'

class DemoAgentExecutor implements AgentExecutor {
  readonly started: AgentExecutionRequest[] = []

  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.started.push(request)
    return { wait: async () => ({ outcome: 'succeeded', summary: `completed ${request.stepId}` }) }
  }
}

class DemoWorkspaceDriver implements WorkspaceDriver {
  async createAttempt(request: CreateAttemptWorkspace) {
    return {
      workspaceId: `demo-${request.stepId}-${request.attempt}`,
      worktreePath: `/tmp/dsh-demo-${request.stepId}`,
    }
  }

  async captureResult() {
    return { resultCommit: 'demo-result-commit' }
  }

  async mergeResult(request: MergeWorkspaceResult) {
    return { merged: true, integrationCommit: request.resultCommit }
  }
}

class DemoVerificationDriver implements VerificationDriver {
  constructor(private readonly failingStep: string) {}

  async run(check: CheckRequest): Promise<CheckResult> {
    if (check.stepId === this.failingStep) {
      return { passed: false, failureMessage: `verification failed for ${check.stepId}` }
    }
    return { passed: true, evidence: { passed: true } }
  }
}

function makeRun(id: string, steps: StepDefinition[], maxParallel: number) {
  return createRunAggregate({
    id,
    repository: { root: '/demo/repository', baseCommit: 'base' },
    steps,
    workflow: { maxParallel, failureMode: 'stop_after_batch' },
    now: 1_000,
  })
}

const repository = new InMemoryRunRepository()
const agentExecutor = new DemoAgentExecutor()
const scheduler = new Scheduler({
  repository,
  agentExecutor,
  workspaceDriver: new DemoWorkspaceDriver(),
  verificationDriver: new DemoVerificationDriver('lint'),
  globalMaxParallel: 2,
})

const lifecycleRun = makeRun('demo-run-lifecycle', [
  { id: 'lint' },
  { id: 'docs' },
  { id: 'next-batch' },
], 2)
await repository.create(lifecycleRun)
console.log('1. Created run:', lifecycleRun.id, 'status=', lifecycleRun.status)

const lifecycleResult = await scheduler.run(lifecycleRun.id)
const firstBatch = Object.values(lifecycleResult.steps)
  .filter((step) => step.batch === 1)
  .map((step) => step.id)
console.log('2. Scheduler batch 1:', firstBatch.join(', '))
console.log('   Agent starts:', agentExecutor.started.map((request) => request.stepId).join(', '))
console.log('   Step results:', {
  lint: lifecycleResult.steps.lint?.status,
  docs: lifecycleResult.steps.docs?.status,
})
console.log('   stop_after_batch:', {
  failedStep: lifecycleResult.steps.lint?.status,
  batchMateContinued: lifecycleResult.steps.docs?.status,
  nextBatchCreated: lifecycleResult.steps['next-batch']?.batch ?? 'no',
  integrationBatch: lifecycleResult.integration.batch,
})
console.log('3. Final lifecycle run status:', lifecycleResult.status)

const cancellationRun = makeRun('demo-run-cancellation', [{ id: 'cancel-me' }], 1)
await repository.create(cancellationRun)
console.log('4. Created run for cancellation:', cancellationRun.id)
const firstCancellation = await requestCancellation(repository, cancellationRun.id)
console.log('   First cancellation:', {
  changed: firstCancellation.changed,
  status: firstCancellation.run.status,
})
const secondCancellation = await requestCancellation(repository, cancellationRun.id)
console.log('   Second cancellation (idempotent):', {
  changed: secondCancellation.changed,
  status: secondCancellation.run.status,
})
const cancellationResult = await scheduler.run(cancellationRun.id)
console.log('5. Scheduler finalized cancellation:', {
  status: cancellationResult.status,
  finishedAt: cancellationResult.finishedAt,
})

console.log('Demo complete')
