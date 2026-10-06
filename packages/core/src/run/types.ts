import type { StepCheck } from '../ports.js'
import type { FailureCodeValue, FailureRecord } from './errors.js'

export type RunId = string
export type StepId = string
export type AttemptId = string
export type ApprovalId = string

export type RunStatus =
  | 'validating'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'waiting_action'
  | 'delivery_ready'
  | 'applying'
  | 'cancelling'
  | 'applied'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type StepStatus =
  | 'pending'
  | 'ready'
  | 'provisioning'
  | 'running'
  | 'verifying'
  | 'waiting_approval'
  | 'merge_queued'
  | 'merged'
  | 'succeeded'
  | 'merge_conflict'
  | 'failed'
  | 'cancelled'
  | 'skipped_dependency_failed'
  | 'interrupted'

export type AttemptStatus =
  | 'provisioning'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface AgentCompletion {
  summary?: string
  /**
   * How the agent's turn ended. Anything but `succeeded` (or absent, which
   * the Scheduler reads as succeeded for executors that predate this field)
   * fails the attempt before verification: the checks judge finished work,
   * not whatever a cut-off or aborted agent left behind.
   */
  outcome?: 'succeeded' | 'failed' | 'blocked' | 'cancelled'
  /** Human-readable reason when `outcome` is not `succeeded`. */
  error?: string
  /**
   * Failure category for a non-succeeded outcome, when the executor knows a
   * better one than the default (`step_timeout` for a turn that hit its
   * cap, for instance). Default: `cancelled` for a cancelled outcome,
   * `agent_failed` otherwise.
   */
  failureCode?: FailureCodeValue
  value?: JsonValue
  [key: string]: unknown
}

export interface VerificationEvidence {
  passed: boolean
  checks?: Array<{
    name: string
    exitCode?: number
    signal?: string
    durationMs?: number
    outputSummary?: string
  }>
  changedPaths?: string[]
  diffHash?: string
}

/**
 * Which upstream results a step's agent was given (a workflow step's
 * `consumes`): enough to tell from the run record alone what the
 * downstream agent saw.
 */
export interface ConsumedArtifactRef {
  step: StepId
  /** Upstream attempt the artifacts came from; absent when it had none to give. */
  attempt?: number
  artifacts: string[]
  /** Upstream candidate commit, when `diff` was consumed and there was one. */
  resultCommit?: string
}

export interface StepAttempt {
  attempt: number
  id?: AttemptId
  status: AttemptStatus
  inputCommit: string
  workspaceId?: string
  worktreePath?: string
  agentSessionId?: string
  resolvedRoute?: { provider: string; model: string }
  startedAt?: number
  finishedAt?: number
  completions: Array<{ round: number; submittedAt: number; value: AgentCompletion }>
  evidence?: VerificationEvidence
  resultCommit?: string
  failure?: FailureRecord
  /** Upstream artifacts put in front of this attempt's agent (`consumes`). */
  consumed?: ConsumedArtifactRef[]
}

export interface StepDefinition {
  id: StepId
  dependsOn?: StepId[]
  dependencies?: StepId[]
  order?: number
  readOnly?: boolean
  requiresApproval?: boolean
  maxAttempts?: number
  metadata?: Record<string, unknown>
}

export interface StepAggregate extends StepDefinition {
  status: StepStatus
  attempts: StepAttempt[]
  failure?: FailureRecord
  resultCommit?: string
  mergeEvidence?: Record<string, unknown>
  batch?: number
}

export interface WorkflowSnapshot {
  maxParallel?: number
  failureMode?: 'stop_after_batch'
  steps?: StepDefinition[]
  totalDeadlineAt?: number
  /** Workspace setup commands (a compiled workflow's `spec.workspace.setup`), run in every attempt worktree. */
  setup?: StepCheck[]
}

export interface RepositorySnapshot {
  root: string
  gitCommonDir?: string
  baseCommit: string
}

export interface IntegrationSnapshot {
  ref: string
  commit: string
  batch: number
}

export interface BudgetSnapshot {
  tokenLimit?: number
  costLimit?: number
  deadlineAt?: number
  reservedTokens?: number
}

export interface UsageSnapshot {
  tokens: number
  cost?: number
  durationMs?: number
}

export interface ApprovalRecord {
  id: ApprovalId
  status: 'pending' | 'approved' | 'rejected'
  requestedAt?: number
  resolvedAt?: number
}

export interface RunInitiator {
  kind: 'agent' | 'ui'
  sessionId?: string
}

export interface RunAggregate {
  schemaVersion: 1
  id: RunId
  revision: number
  eventSequence: number
  workflowId: string
  workflowHash: string
  initiator: RunInitiator
  repository: RepositorySnapshot
  integration: IntegrationSnapshot
  status: RunStatus
  steps: Record<StepId, StepAggregate>
  approvals: Record<ApprovalId, ApprovalRecord>
  budget: BudgetSnapshot
  usage: UsageSnapshot
  cancelRequestedAt?: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
  failure?: FailureRecord
  workflow?: WorkflowSnapshot
  idempotencyKey?: string
  processedCommandIds?: string[]
}

export function getStepDependencies(step: Pick<StepDefinition, 'dependsOn' | 'dependencies'>): StepId[] {
  return [...(step.dependsOn ?? step.dependencies ?? [])]
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'applied' || status === 'failed' || status === 'cancelled'
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return status === 'merged' || status === 'succeeded' || status === 'failed' ||
    status === 'cancelled' || status === 'skipped_dependency_failed' || status === 'interrupted'
}

export function createRunAggregate(input: {
  id: RunId
  workflowId?: string
  workflowHash?: string
  initiator?: RunInitiator
  repository: RepositorySnapshot
  steps: StepDefinition[] | Record<StepId, StepAggregate>
  integration?: Partial<IntegrationSnapshot>
  budget?: BudgetSnapshot
  now?: number
  status?: RunStatus
  workflow?: WorkflowSnapshot
  idempotencyKey?: string
}): RunAggregate {
  const now = input.now ?? Date.now()
  const steps = Array.isArray(input.steps)
    ? Object.fromEntries(input.steps.map((definition, index) => [definition.id, {
      ...definition,
      order: definition.order ?? index,
      status: 'pending' as const,
      attempts: [],
    }]))
    : input.steps
  return {
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    eventSequence: 0,
    workflowId: input.workflowId ?? 'workflow',
    workflowHash: input.workflowHash ?? '',
    initiator: input.initiator ?? { kind: 'ui' },
    repository: input.repository,
    integration: {
      // `refs/dsh-orchestrator/` is the namespace the docs reserve
      // and the only one GitWorkspaceDriver.mergeResult
      // accepts; the previous `refs/dsh/` default made every merge with a real
      // driver fail "Invalid integration identity or ref".
      ref: input.integration?.ref ?? `refs/dsh-orchestrator/runs/${input.id}/integration`,
      commit: input.integration?.commit ?? input.repository.baseCommit,
      batch: input.integration?.batch ?? 0,
    },
    status: input.status ?? 'ready',
    steps,
    approvals: {},
    budget: input.budget ?? {},
    usage: { tokens: 0 },
    createdAt: now,
    updatedAt: now,
    // "No parallel limit" is the *absence* of `maxParallel`: the Scheduler
    // reads `run.workflow?.maxParallel ?? Infinity`, and an absent key is the
    // only encoding of "unlimited" that survives a JSON round trip through a
    // durable repository (`JSON.stringify(Infinity)` is `null`; behavior).
    workflow: input.workflow ?? { failureMode: 'stop_after_batch' },
    idempotencyKey: input.idempotencyKey,
  }
}
