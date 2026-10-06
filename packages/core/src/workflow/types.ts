/** Result of statically checking workflow step contracts. */
export interface ContractCheckResult {
  valid: boolean
  errors: ContractError[]
  warnings: ContractWarning[]
}

/** A contract incompatibility that prevents a workflow from being valid. */
export interface ContractError {
  stepId: string
  upstreamStepId?: string
  field: string
  message: string
}

/** A contract issue that is useful to surface without rejecting a workflow. */
export interface ContractWarning {
  stepId: string
  message: string
}

/** Minimal workflow step shape required by the contract checker. */
export interface WorkflowStepDef {
  id: string
  roleId: string
  dependsOn: string[]
  /**
   * Fields this step receives without an upstream step: the workflow's own
   * inputs (by name), and `task_description` when the step has instructions —
   * a step's instructions are the task it hands its role.
   */
  provided?: string[]
}

/** Injectable access to instruction files owned by the repository adapter. */
export interface WorkflowFileResolver {
  /**
   * Read a repository-relative instruction file.
   *
   * @param relativePath - Normalized repository-relative path.
   * @returns File contents, or `undefined` when it is missing or not a tracked blob.
   */
  readInstructionsFile(relativePath: string): Promise<string | undefined>
}

/** One user input declaration in canonical workflow form. */
export interface CanonicalWorkflowInput {
  readonly type: string
  readonly required: boolean
  readonly max_length: number | null
}

/** Canonical workflow metadata. */
export interface CanonicalWorkflowMetadata {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** Canonical run execution limits. */
export interface CanonicalWorkflowExecution {
  readonly max_parallel: number
  readonly failure_mode: 'stop_after_batch'
  readonly max_run_seconds: number
}

/** Canonical repository workspace policy. */
export interface CanonicalWorkflowWorkspace {
  readonly strategy: 'git_worktree'
  readonly dirty_policy: 'reject'
  readonly merge_strategy: 'deterministic_cherry_pick'
  readonly final_apply: 'approval_required'
  /** Commands run controller-side in every fresh attempt worktree before its agent starts. */
  readonly setup?: readonly CanonicalCheckDefinition[]
}

/** Canonical workflow budget. */
export interface CanonicalWorkflowBudget {
  readonly max_total_tokens: number
  readonly max_cost_usd: number
  readonly on_unknown_price: 'require_approval' | 'reject'
}

/** Canonical upstream artifact selection. */
export interface CanonicalArtifactSelector {
  readonly step: string
  readonly artifacts: readonly string[]
}

/** Canonical path policy for a workflow step. */
export interface CanonicalPathPolicy {
  readonly allow_changes: readonly string[]
  readonly deny_changes: readonly string[]
}

/** Canonical controller-owned check definition. */
export interface CanonicalCheckDefinition {
  readonly id: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly timeout_seconds: number
  readonly env_allow: readonly string[]
  readonly required: boolean
}

/** Canonical timeout, retry, repair, and merge approval policy. */
export interface CanonicalStepPolicy {
  readonly timeout_seconds: number
  readonly repair_rounds: number
  readonly retries: number
  readonly approval_before_merge: boolean
  /** A write step that changed nothing ends `succeeded` (nothing to merge) instead of failing. */
  readonly allow_no_changes?: boolean
}

/** Canonical agent step with every optional value expanded. */
export interface CanonicalAgentStep {
  readonly id: string
  readonly kind: 'agent'
  readonly role: string
  readonly mode: 'read' | 'write'
  readonly depends_on: readonly string[]
  readonly instructions: string | null
  readonly instructions_file: string | null
  readonly instructions_file_content: string | null
  /** Scenario of the step's role to apply to its task (roles `scenarios` / project layer). */
  readonly scenario?: string
  readonly consumes: readonly CanonicalArtifactSelector[]
  readonly paths: CanonicalPathPolicy
  readonly checks: readonly CanonicalCheckDefinition[]
  readonly policy: CanonicalStepPolicy
}

/** Fully expanded, deeply frozen workflow representation consumed by the kernel. */
export interface CanonicalWorkflowIR {
  readonly api_version: 'dsh.orchestrator/v1alpha1'
  readonly kind: 'Workflow'
  readonly metadata: CanonicalWorkflowMetadata
  readonly spec: {
    readonly inputs: Readonly<Record<string, CanonicalWorkflowInput>>
    readonly execution: CanonicalWorkflowExecution
    readonly workspace: CanonicalWorkflowWorkspace
    readonly budget: CanonicalWorkflowBudget
    readonly steps: readonly CanonicalAgentStep[]
  }
}

/** A fatal workflow compile diagnostic. */
export interface WorkflowCompileError {
  /** JSON Pointer identifying the invalid value. */
  path: string
  /** Human-readable reason the value is invalid. */
  message: string
}

/** A non-fatal workflow compile diagnostic. */
export interface WorkflowCompileWarning {
  /** JSON Pointer identifying the value that could not be fully checked. */
  path: string
  /** Human-readable explanation of the skipped or uncertain check. */
  message: string
}

/** Result returned by {@link WorkflowCompiler.compile}. */
export interface WorkflowCompileResult {
  valid: boolean
  ir?: CanonicalWorkflowIR
  workflowHash?: string
  errors: WorkflowCompileError[]
  warnings: WorkflowCompileWarning[]
}
