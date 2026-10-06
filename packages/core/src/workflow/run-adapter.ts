import {
  createRunAggregate,
  type RepositorySnapshot,
  type RunAggregate,
  type RunId,
  type RunInitiator,
  type StepDefinition,
} from '../run/types.js'
import { renderTemplate } from './template.js'
import type { CanonicalAgentStep, CanonicalWorkflowIR } from './types.js'

/** Inputs required to create a scheduler-ready run from compiled workflow IR. */
export interface CreateRunFromWorkflowOptions {
  /** Stable identity assigned to the new run by the caller. */
  runId: RunId
  /** Successfully compiled canonical workflow definition. */
  ir: CanonicalWorkflowIR
  /** Hash returned alongside the canonical IR by {@link WorkflowCompiler.compile}. */
  workflowHash: string
  /** Repository state against which the run must execute. */
  repository: RepositorySnapshot
  /** Actor that requested the run. Defaults to the UI initiator used by the aggregate factory. */
  initiator?: RunInitiator
  /** Epoch milliseconds used for creation and absolute deadline calculation. */
  now?: number
  /** Optional key used to deduplicate equivalent run starts. */
  idempotencyKey?: string
  /**
   * Values for the workflow's `spec.inputs`, already validated by the caller.
   * Rendered into each step's instructions (`${{ inputs.<name> }}`) when the
   * Run is created.
   */
  input?: Readonly<Record<string, unknown>>
  /**
   * Harness for every step, overriding what each step's role declares — a
   * property of this Run's environment (e.g. one harness is unavailable on
   * this machine), not of the workflow. The roles and their hashes stay as
   * they are.
   */
  harness?: string
}

/**
 * Convert compiled workflow IR into the aggregate shape consumed by {@link Scheduler.run}.
 *
 * @param options - Canonical workflow output plus run-specific repository and identity data.
 * @returns A new run aggregate in the `ready` state.
 */
export function createRunFromWorkflow(
  options: CreateRunFromWorkflowOptions,
): RunAggregate {
  const now = options.now ?? Date.now()
  const values = { inputs: options.input ?? {}, runId: options.runId }
  const steps = options.ir.spec.steps.map((step) => toStepDefinition(step, values, options.harness))

  return createRunAggregate({
    id: options.runId,
    workflowId: options.ir.metadata.id,
    workflowHash: options.workflowHash,
    initiator: options.initiator,
    repository: options.repository,
    steps,
    workflow: {
      maxParallel: options.ir.spec.execution.max_parallel,
      failureMode: options.ir.spec.execution.failure_mode,
      totalDeadlineAt: now + options.ir.spec.execution.max_run_seconds * 1_000,
      steps,
      ...(options.ir.spec.workspace.setup === undefined ? {} : {
        setup: options.ir.spec.workspace.setup.map((check) => ({
          id: check.id,
          command: [...check.command],
          cwd: check.cwd,
          timeoutSeconds: check.timeout_seconds,
          envAllow: [...check.env_allow],
          required: check.required,
        })),
      }),
    },
    budget: {
      tokenLimit: options.ir.spec.budget.max_total_tokens,
      costLimit: options.ir.spec.budget.max_cost_usd,
    },
    now,
    idempotencyKey: options.idempotencyKey,
  })
}

function toStepDefinition(step: CanonicalAgentStep, values: { inputs: Readonly<Record<string, unknown>>; runId: string }, harness: string | undefined): StepDefinition {
  const render = (text: string | null): string | null => text === null ? null : renderTemplate(text, { ...values, stepId: step.id })
  return {
    id: step.id,
    dependsOn: [...step.depends_on],
    readOnly: step.mode === 'read',
    requiresApproval: step.policy.approval_before_merge,
    maxAttempts: step.policy.retries + 1,
    metadata: {
      role: step.role,
      mode: step.mode,
      // The step's mode decides what its agent may do to the worktree (a
      // read step runs read-only); the project policy can still refuse it.
      sandbox: step.mode === 'write' ? 'workspace-write' : 'read-only',
      ...(harness === undefined ? {} : { harness }),
      // Rendered with this Run's inputs: the text the step's agent receives.
      // The template itself stays in the compiled IR (and its hash).
      instructions: render(step.instructions),
      instructions_file: step.instructions_file,
      instructions_file_content: render(step.instructions_file_content),
      ...(step.scenario === undefined ? {} : { scenario: step.scenario }),
      consumes: step.consumes,
      paths: step.paths,
      checks: step.checks,
      policy: step.policy,
    },
  }
}
