import type {
  AgentCompletion,
  AttemptId,
  RepositorySnapshot,
  RunId,
  StepId,
  VerificationEvidence,
} from './run/types.js'

export interface AgentExecutionRequest {
  runId: RunId
  stepId: StepId
  attempt: number
  attemptId?: AttemptId
  inputCommit: string
  workspaceId?: string
  worktreePath?: string
  prompt?: string
  /** Role id resolved for this step, from StepAggregate.metadata.role. */
  roleId?: string
  /**
   * Harness sandbox mode the step's agent should run under, from
   * StepAggregate.metadata.sandbox. An opaque string here: which values exist
   * and whether the project policy allows them is the executor's business.
   */
  sandbox?: string
  /**
   * Harness the step's agent should run on, from StepAggregate.metadata.harness,
   * overriding the role's own declaration. Same opacity as `sandbox`.
   */
  harness?: string
  /**
   * Scenario of the step's role to apply to this task, from
   * StepAggregate.metadata.scenario. Opaque here; the executor resolves it.
   */
  scenario?: string
  signal?: AbortSignal
}

export interface AgentExecutionHandle {
  wait(): Promise<AgentCompletion>
  /**
   * Stop the agent and whatever it started. Called when the run is cancelled,
   * in addition to aborting the request's `signal`; `wait()` is expected to
   * settle soon after (with `outcome: 'cancelled'`).
   */
  cancel?(): Promise<void> | void
  dispose?(): Promise<void> | void
}

export interface AgentExecutor {
  start(request: AgentExecutionRequest): Promise<AgentExecutionHandle>
}

export interface CreateAttemptWorkspace {
  runId: RunId
  stepId: StepId
  attempt: number
  inputCommit: string
  repository: RepositorySnapshot
  /**
   * Commands to run in the fresh worktree before the agent starts (a
   * workflow's `spec.workspace.setup`). A driver that prepares workspaces
   * runs them and fails the attempt when a required one fails.
   */
  setup?: StepCheck[]
}

export interface AttemptWorkspace {
  workspaceId: string
  worktreePath?: string
  inputCommit?: string
}

export interface CaptureWorkspaceResult {
  runId: RunId
  stepId: StepId
  attempt: number
  workspaceId: string
}

export interface WorkspaceResult {
  resultCommit?: string
  changedPaths?: string[]
  diffHash?: string
  evidence?: VerificationEvidence
}

export interface MergeWorkspaceResult {
  runId: RunId
  stepId: StepId
  resultCommit: string
  integrationRef: string
  /**
   * Current integration head; the merge lands on top of it and the ref is
   * advanced with it as the expected old value. The candidate itself may be
   * based on an older integration commit of the same run — every step of a
   * batch starts from the same baseline, and all but the first to merge find
   * the integration already moved on.
   */
  expectedIntegrationCommit: string
  /**
   * Repository the run belongs to. Lets a driver merge a candidate it did not
   * capture itself — after a restart, or when another scheduler process took
   * the run over.
   */
  repositoryRoot?: string
}

export interface MergeResult {
  merged: boolean
  integrationCommit?: string
  evidence?: Record<string, unknown>
  conflict?: string
}

export interface WorkspaceDriver {
  inspectRepository?(root: string): Promise<RepositorySnapshot>
  createAttempt(request: CreateAttemptWorkspace): Promise<AttemptWorkspace>
  captureResult?(request: CaptureWorkspaceResult): Promise<WorkspaceResult>
  mergeResult?(request: MergeWorkspaceResult): Promise<MergeResult>
  removeAttempt?(workspaceId: string): Promise<void>
}

export interface CheckRequest {
  runId: RunId
  stepId: StepId
  attempt: number
  workspaceId?: string
  worktreePath?: string
  checks?: string[]
  /**
   * The checks the step itself declares (a compiled workflow's
   * `steps[].checks`), for a driver that runs per-step checks. A driver with
   * a fixed check list of its own may ignore this.
   */
  commands?: StepCheck[]
  signal?: AbortSignal
}

/** One check a workflow step declares, as the Scheduler hands it to a verification driver. */
export interface StepCheck {
  id: string
  /** argv, run without a shell. */
  command: readonly string[]
  /** Working directory relative to the worktree root. */
  cwd: string
  timeoutSeconds: number
  /** Names of the only environment variables passed through from the controller. */
  envAllow: readonly string[]
  /** A failing check that is not required is recorded but does not fail the step. */
  required: boolean
}

export interface CheckResult {
  passed: boolean
  evidence?: VerificationEvidence
  failureMessage?: string
}

export interface VerificationDriver {
  run(check: CheckRequest): Promise<CheckResult>
}

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }
