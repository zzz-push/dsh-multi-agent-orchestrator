import { randomUUID } from 'node:crypto'

import {
  createRunFromWorkflow,
  WorkflowCompiler,
  type CanonicalWorkflowInput,
  type RepositorySnapshot,
  type RunAggregate,
  type RunInitiator,
  type RunRepository,
  type Scheduler,
  type WorkflowCompileError,
} from '@dsh/core'

import type { RoleProvider } from '../role/types.js'
import { extractStepRoleIds } from './extract-role-ids.js'
import { FileWorkflowSkillProvider } from './file-provider.js'
import { resolveWorkflowRoles } from './role-resolver.js'

/** Inputs required to discover, compile, persist, and schedule one workflow Run. */
export interface StartWorkflowOptions {
  /** Stable workflow id declared by the Skill Pack manifest. */
  workflowId: string
  /** Values supplied for the compiled workflow's `spec.inputs` schema. */
  input: Record<string, unknown>
  /** Directory whose immediate children contain workflow Skill Packs. */
  skillsDir: string
  /** Global role source used after Pack-local roles are checked. */
  globalRoles: RoleProvider
  /** Repository state against which the Run executes. */
  repository: RepositorySnapshot
  /** Already configured scheduler; drivers and infrastructure are owned by the caller. */
  scheduler: Scheduler
  /** Repository used to persist the newly created Run before scheduling. */
  runRepository: RunRepository
  /** Optional caller-supplied Run id; a UUID is generated when omitted. */
  runId?: string
  /** Actor that requested the Run. */
  initiator?: RunInitiator
  /** Epoch milliseconds used for Run creation and deadline calculation. */
  now?: number
  /** Optional idempotency key recorded on the Run. */
  idempotencyKey?: string
  /** Harness for every step, overriding the roles' declarations (see `createRunFromWorkflow`). */
  harness?: string
}

export type StartWorkflowResult =
  | {
      outcome: 'started'
      runId: string
      /**
       * The detached scheduling call. Resolves with the Run once the
       * Scheduler reaches a wait or terminal state; rejects if scheduling
       * fails. Callers that do not wait for it can ignore it — it never
       * becomes an unhandled rejection.
       */
      settled: Promise<RunAggregate>
    }
  | { outcome: 'workflow_not_found' }
  | { outcome: 'invalid_input'; errors: WorkflowInputValidationError[] }
  | { outcome: 'compile_failed'; errors: WorkflowCompileError[] }

/** A caller-facing violation of a compiled workflow input declaration. */
export interface WorkflowInputValidationError {
  /** JSON Pointer to the declared input, for example `/spec/inputs/task`. */
  path: string
  /** Human-readable explanation of the violation. */
  message: string
}

/**
 * Validate supplied values against the canonical `spec.inputs` declarations.
 *
 * The compiler currently defines string input constraints (`required` and
 * `max_length`). Unknown input types are left untouched until the workflow
 * schema gives them explicit runtime semantics.
 */
export function validateWorkflowInput(
  inputsSchema: Readonly<Record<string, CanonicalWorkflowInput>>,
  suppliedInput: Readonly<Record<string, unknown>>,
): WorkflowInputValidationError[] {
  const errors: WorkflowInputValidationError[] = []

  for (const [name, declaration] of Object.entries(inputsSchema)) {
    const path = `/spec/inputs/${escapePointer(name)}`
    const value = suppliedInput?.[name]
    const missing = value === undefined

    if (missing) {
      if (declaration.required) {
        errors.push({ path, message: '必填输入缺失' })
      }
      continue
    }

    if (declaration.type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ path, message: '输入必须是字符串' })
        continue
      }
      if (declaration.max_length !== null && value.length > declaration.max_length) {
        errors.push({
          path,
          message: `输入长度不能超过 ${declaration.max_length} 个字符`,
        })
      }
    }
  }

  return errors
}

/**
 * Start a workflow without waiting for the Scheduler to finish the Run.
 *
 * Discovery, role resolution, compilation, and input validation all happen
 * before the Run is persisted. Scheduler execution is deliberately detached
 * after persistence so long-running workflows do not block this entry point.
 */
export async function startWorkflow(
  options: StartWorkflowOptions,
): Promise<StartWorkflowResult> {
  const provider = new FileWorkflowSkillProvider({ skillsDir: options.skillsDir })
  const discovered = await provider.get(options.workflowId)
  if (discovered === undefined) return { outcome: 'workflow_not_found' }

  const requiredRoleIds = extractStepRoleIds(discovered.rawWorkflow)
  const resolved = await resolveWorkflowRoles({
    localRolesDir: discovered.localRolesDir,
    requiredRoleIds,
    globalRoles: options.globalRoles,
  })

  const compiled = await new WorkflowCompiler().compile(discovered.rawWorkflow, resolved.roles)
  if (!compiled.valid || compiled.ir === undefined || compiled.workflowHash === undefined) {
    return { outcome: 'compile_failed', errors: compiled.errors }
  }

  const inputErrors = validateWorkflowInput(compiled.ir.spec.inputs, options.input)
  if (inputErrors.length > 0) return { outcome: 'invalid_input', errors: inputErrors }

  const run = createRunFromWorkflow({
    runId: options.runId ?? randomUUID(),
    ir: compiled.ir,
    workflowHash: compiled.workflowHash,
    repository: options.repository,
    initiator: options.initiator,
    now: options.now,
    idempotencyKey: options.idempotencyKey,
    input: options.input,
    ...(options.harness === undefined ? {} : { harness: options.harness }),
  })

  await options.runRepository.create(run)

  // Starting a Run is intentionally fire-and-forget. A rejected scheduling
  // promise must still be observed so it cannot become an unhandled rejection;
  // attaching the handler marks `settled` itself as handled, and a caller that
  // wants the outcome can still await it.
  const settled = options.scheduler.run(run.id)
  settled.catch(() => undefined)

  return { outcome: 'started', runId: run.id, settled }
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}
