import { createHash } from 'node:crypto'

import type { RoleDefinition } from '@dsh/spec'

import { ContractChecker } from './contract-checker.js'
import { CONSUMABLE_ARTIFACTS } from './upstream-artifacts.js'
import { stableSerialize } from './stable-serialize.js'
import type {
  CanonicalAgentStep,
  CanonicalArtifactSelector,
  CanonicalCheckDefinition,
  CanonicalPathPolicy,
  CanonicalStepPolicy,
  CanonicalWorkflowBudget,
  CanonicalWorkflowExecution,
  CanonicalWorkflowIR,
  CanonicalWorkflowInput,
  CanonicalWorkflowMetadata,
  CanonicalWorkflowWorkspace,
  WorkflowCompileError,
  WorkflowCompileResult,
  WorkflowCompileWarning,
  WorkflowFileResolver,
  WorkflowStepDef,
} from './types.js'

const API_VERSION = 'dsh.orchestrator/v1alpha1' as const
const COMPILER_VERSION = '1.0.0'
const GLOB_SEMANTICS_VERSION = '1'
const TEMPLATE_SEMANTICS_VERSION = '1'
const MAX_IR_BYTES = 1024 * 1024
const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

const TOP_LEVEL_FIELDS = new Set(['api_version', 'kind', 'metadata', 'spec'])
const METADATA_FIELDS = new Set(['id', 'name', 'description'])
const SPEC_FIELDS = new Set(['inputs', 'execution', 'workspace', 'budget', 'steps'])
const INPUT_FIELDS = new Set(['type', 'required', 'max_length'])
const EXECUTION_FIELDS = new Set(['max_parallel', 'failure_mode', 'max_run_seconds'])
const WORKSPACE_FIELDS = new Set([
  'strategy',
  'dirty_policy',
  'merge_strategy',
  'final_apply',
  'setup',
])
const BUDGET_FIELDS = new Set(['max_total_tokens', 'max_cost_usd', 'on_unknown_price'])
const STEP_FIELDS = new Set([
  'id',
  'kind',
  'role',
  'mode',
  'depends_on',
  'instructions',
  'instructions_file',
  'scenario',
  'consumes',
  'paths',
  'checks',
  'policy',
])
const CONSUMES_FIELDS = new Set(['step', 'artifacts'])
const PATH_FIELDS = new Set(['allow_changes', 'deny_changes'])
const CHECK_FIELDS = new Set([
  'id',
  'command',
  'cwd',
  'timeout_seconds',
  'env_allow',
  'required',
])
const POLICY_FIELDS = new Set([
  'timeout_seconds',
  'repair_rounds',
  'retries',
  'approval_before_merge',
  'allow_no_changes',
])

interface CompileContext {
  errors: WorkflowCompileError[]
  warnings: WorkflowCompileWarning[]
  roles: Map<string, RoleDefinition>
  fileResolver?: WorkflowFileResolver
}

/** Compile a parsed workflow document into deterministic kernel IR. */
export class WorkflowCompiler {
  private readonly contractChecker = new ContractChecker()

  /**
   * Validate and compile a parsed workflow document.
   *
   * @param rawWorkflow - Value returned by a safe YAML parser.
   * @param roles - Fully resolved role definitions keyed by role id.
   * @param fileResolver - Optional repository adapter for instruction files.
   * @returns A frozen IR and stable hash when validation succeeds.
   */
  async compile(
    rawWorkflow: unknown,
    roles: Map<string, RoleDefinition>,
    fileResolver?: WorkflowFileResolver,
  ): Promise<WorkflowCompileResult> {
    const context: CompileContext = { errors: [], warnings: [], roles, fileResolver }
    if (!isRecord(rawWorkflow)) {
      addError(context, '/', 'workflow 必须是对象')
      return invalidResult(context)
    }

    rejectUnknownFields(rawWorkflow, TOP_LEVEL_FIELDS, '', context)
    readLiteral(rawWorkflow.api_version, API_VERSION, '/api_version', context)
    readLiteral(rawWorkflow.kind, 'Workflow', '/kind', context)

    const metadata = compileMetadata(rawWorkflow.metadata, context)
    const spec = await compileSpec(rawWorkflow.spec, context)
    validateGraph(spec.steps, context)
    validateContracts(spec.steps, context, this.contractChecker, Object.keys(spec.inputs))

    const ir: CanonicalWorkflowIR = {
      api_version: API_VERSION,
      kind: 'Workflow',
      metadata,
      spec,
    }

    const serializedIR = stableSerialize(ir)
    if (Buffer.byteLength(serializedIR, 'utf8') > MAX_IR_BYTES) {
      addError(context, '/', '展开后的 Canonical IR 不能超过 1 MiB')
    }

    if (context.errors.length > 0) return invalidResult(context)

    const frozenIR = deepFreeze(ir)
    const hashInput = stableSerialize({
      compiler_version: COMPILER_VERSION,
      glob_semantics_version: GLOB_SEMANTICS_VERSION,
      template_semantics_version: TEMPLATE_SEMANTICS_VERSION,
      workflow: frozenIR,
    })

    return {
      valid: true,
      ir: frozenIR,
      workflowHash: createHash('sha256').update(hashInput).digest('hex'),
      errors: [],
      warnings: context.warnings,
    }
  }
}

function compileMetadata(value: unknown, context: CompileContext): CanonicalWorkflowMetadata {
  const metadata = readRecord(value, '/metadata', context)
  if (!metadata) return { id: '', name: '', description: '' }

  rejectUnknownFields(metadata, METADATA_FIELDS, '/metadata', context)
  const id = readString(metadata.id, '/metadata/id', context)
  const name = readString(metadata.name, '/metadata/name', context)
  const description = readOptionalString(metadata.description, '/metadata/description', context)

  if (id && !ID_PATTERN.test(id)) {
    addError(context, '/metadata/id', `id 必须匹配 ${ID_PATTERN.source}`)
  }
  if (name && name.length > 80) {
    addError(context, '/metadata/name', 'name 长度必须在 1 到 80 个字符之间')
  }

  return { id, name, description: description ?? '' }
}

async function compileSpec(
  value: unknown,
  context: CompileContext,
): Promise<CanonicalWorkflowIR['spec']> {
  const spec = readRecord(value, '/spec', context)
  if (!spec) return emptySpec()

  rejectUnknownFields(spec, SPEC_FIELDS, '/spec', context)
  const inputs = compileInputs(spec.inputs, context)
  const execution = compileExecution(spec.execution, context)
  const workspace = compileWorkspace(spec.workspace, context)
  const budget = compileBudget(spec.budget, context)
  const steps = await compileSteps(spec.steps, inputs, context)

  return { inputs, execution, workspace, budget, steps }
}

function compileInputs(
  value: unknown,
  context: CompileContext,
): Record<string, CanonicalWorkflowInput> {
  if (value === undefined) return {}
  const inputRecord = readRecord(value, '/spec/inputs', context)
  if (!inputRecord) return {}

  const inputs: Record<string, CanonicalWorkflowInput> = Object.create(null)
  for (const [name, rawInput] of Object.entries(inputRecord)) {
    const path = `/spec/inputs/${escapePointer(name)}`
    const input = readRecord(rawInput, path, context)
    if (!input) continue
    rejectUnknownFields(input, INPUT_FIELDS, path, context)

    const type = readString(input.type, `${path}/type`, context)
    const required = readOptionalBoolean(input.required, `${path}/required`, context) ?? false
    const maxLength = readOptionalPositiveInteger(
      input.max_length,
      `${path}/max_length`,
      context,
    )
    if (maxLength !== undefined && type && type !== 'string') {
      addError(context, `${path}/max_length`, 'max_length 只适用于 string 输入')
    }
    inputs[name] = { type, required, max_length: maxLength ?? null }
  }
  return inputs
}

function compileExecution(
  value: unknown,
  context: CompileContext,
): CanonicalWorkflowExecution {
  const execution = readRecord(value, '/spec/execution', context)
  if (!execution) {
    return { max_parallel: 0, failure_mode: 'stop_after_batch', max_run_seconds: 0 }
  }

  rejectUnknownFields(execution, EXECUTION_FIELDS, '/spec/execution', context)
  const maxParallel = readPositiveInteger(
    execution.max_parallel,
    '/spec/execution/max_parallel',
    context,
  )
  readLiteral(
    execution.failure_mode,
    'stop_after_batch',
    '/spec/execution/failure_mode',
    context,
  )
  const maxRunSeconds = readPositiveInteger(
    execution.max_run_seconds,
    '/spec/execution/max_run_seconds',
    context,
  )
  return {
    max_parallel: maxParallel,
    failure_mode: 'stop_after_batch',
    max_run_seconds: maxRunSeconds,
  }
}

function compileWorkspace(
  value: unknown,
  context: CompileContext,
): CanonicalWorkflowWorkspace {
  const workspace = readRecord(value, '/spec/workspace', context)
  if (!workspace) return defaultWorkspace()

  rejectUnknownFields(workspace, WORKSPACE_FIELDS, '/spec/workspace', context)
  readLiteral(workspace.strategy, 'git_worktree', '/spec/workspace/strategy', context)
  readLiteral(workspace.dirty_policy, 'reject', '/spec/workspace/dirty_policy', context)
  readLiteral(
    workspace.merge_strategy,
    'deterministic_cherry_pick',
    '/spec/workspace/merge_strategy',
    context,
  )
  readLiteral(
    workspace.final_apply,
    'approval_required',
    '/spec/workspace/final_apply',
    context,
  )
  // Commands the controller runs in every fresh attempt worktree before the
  // agent starts (dependency install, generated files). Same shape as a
  // step's checks. Only present in the IR when declared, so workflows that
  // do not use it keep their hash.
  const setup = compileChecks(workspace.setup, '/spec/workspace', context, 'setup')
  return setup.length === 0 ? defaultWorkspace() : { ...defaultWorkspace(), setup }
}

function compileBudget(value: unknown, context: CompileContext): CanonicalWorkflowBudget {
  const budget = readRecord(value, '/spec/budget', context)
  if (!budget) {
    return { max_total_tokens: 0, max_cost_usd: 0, on_unknown_price: 'reject' }
  }

  rejectUnknownFields(budget, BUDGET_FIELDS, '/spec/budget', context)
  const maxTotalTokens = readPositiveInteger(
    budget.max_total_tokens,
    '/spec/budget/max_total_tokens',
    context,
  )
  const maxCostUsd = readNonNegativeNumber(
    budget.max_cost_usd,
    '/spec/budget/max_cost_usd',
    context,
  )
  const onUnknownPrice = readEnum(
    budget.on_unknown_price,
    ['require_approval', 'reject'] as const,
    '/spec/budget/on_unknown_price',
    context,
  ) ?? 'reject'

  if (maxCostUsd === 0 && onUnknownPrice === 'require_approval') {
    addError(
      context,
      '/spec/budget/on_unknown_price',
      'max_cost_usd 为 0 时不能为未知价格请求额外批准',
    )
  }
  return {
    max_total_tokens: maxTotalTokens,
    max_cost_usd: maxCostUsd,
    on_unknown_price: onUnknownPrice,
  }
}

async function compileSteps(
  value: unknown,
  inputs: Record<string, CanonicalWorkflowInput>,
  context: CompileContext,
): Promise<CanonicalAgentStep[]> {
  if (!Array.isArray(value)) {
    addError(context, '/spec/steps', 'steps 必须是非空数组')
    return []
  }
  if (value.length === 0) addError(context, '/spec/steps', 'steps 必须是非空数组')

  const steps: CanonicalAgentStep[] = []
  for (let index = 0; index < value.length; index += 1) {
    steps.push(await compileStep(value[index], index, inputs, context))
  }
  validateStepIds(steps, context)
  validateStepReferences(steps, context)
  return steps
}

async function compileStep(
  value: unknown,
  index: number,
  inputs: Record<string, CanonicalWorkflowInput>,
  context: CompileContext,
): Promise<CanonicalAgentStep> {
  const path = `/spec/steps/${index}`
  const step = readRecord(value, path, context)
  if (!step) return emptyStep()
  rejectUnknownFields(step, STEP_FIELDS, path, context)

  const id = readString(step.id, `${path}/id`, context)
  readLiteral(step.kind, 'agent', `${path}/kind`, context)
  const role = readString(step.role, `${path}/role`, context)
  const mode = readEnum(step.mode, ['read', 'write'] as const, `${path}/mode`, context) ?? 'read'
  const dependsOn = readStringArray(
    step.depends_on,
    `${path}/depends_on`,
    context,
    { required: false },
  )
  const instructions = readOptionalString(step.instructions, `${path}/instructions`, context)
  const instructionsFile = readOptionalString(
    step.instructions_file,
    `${path}/instructions_file`,
    context,
  )
  if (instructions !== undefined && instructionsFile !== undefined) {
    addError(context, path, 'instructions 和 instructions_file 不能同时声明')
  }
  const scenario = readOptionalString(step.scenario, `${path}/scenario`, context)
  if (scenario !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario)) {
    addError(context, `${path}/scenario`, 'scenario 只能用小写字母、数字和 -（最长 64）')
  }

  let instructionsFileContent: string | null = null
  if (instructionsFile !== undefined) {
    if (validateRepoPath(instructionsFile, false, `${path}/instructions_file`, context)) {
      instructionsFileContent = await resolveInstructionsFile(instructionsFile, path, context)
    }
  }

  const consumes = compileConsumes(step.consumes, path, context)
  const paths = compilePaths(step.paths, path, context)
  if (mode === 'write' && paths.allow_changes.length === 0) {
    addError(context, `${path}/paths/allow_changes`, 'write 步骤必须允许至少一个变更路径')
  }
  const checks = compileChecks(step.checks, path, context)
  const policy = compilePolicy(step.policy, path, context)

  validateTemplates(instructions, `${path}/instructions`, inputs, context)
  validateTemplates(
    instructionsFileContent ?? undefined,
    `${path}/instructions_file`,
    inputs,
    context,
  )

  return {
    id,
    kind: 'agent',
    role,
    mode,
    depends_on: dependsOn,
    instructions: instructions ?? null,
    instructions_file: instructionsFile ?? null,
    instructions_file_content: instructionsFileContent,
    // Only present when declared, so adding the field did not change the
    // IR (and hash) of any workflow that does not use it.
    ...(scenario === undefined ? {} : { scenario }),
    consumes,
    paths,
    checks,
    policy,
  }
}

function compileConsumes(
  value: unknown,
  stepPath: string,
  context: CompileContext,
): CanonicalArtifactSelector[] {
  const path = `${stepPath}/consumes`
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    addError(context, path, 'consumes 必须是数组')
    return []
  }

  return value.map((rawSelector, index) => {
    const selectorPath = `${path}/${index}`
    const selector = readRecord(rawSelector, selectorPath, context)
    if (!selector) return { step: '', artifacts: [] }
    rejectUnknownFields(selector, CONSUMES_FIELDS, selectorPath, context)
    const artifacts = readStringArray(
      selector.artifacts,
      `${selectorPath}/artifacts`,
      context,
      { required: true, nonEmpty: true },
    )
    artifacts.forEach((artifact, artifactIndex) => {
      if (!(CONSUMABLE_ARTIFACTS as readonly string[]).includes(artifact)) {
        addError(context, `${selectorPath}/artifacts/${artifactIndex}`, `未知产物: ${artifact}（只支持 ${CONSUMABLE_ARTIFACTS.join(' / ')}）`)
      }
    })
    return {
      step: readString(selector.step, `${selectorPath}/step`, context),
      artifacts,
    }
  })
}

function compilePaths(
  value: unknown,
  stepPath: string,
  context: CompileContext,
): CanonicalPathPolicy {
  const path = `${stepPath}/paths`
  if (value === undefined) return { allow_changes: [], deny_changes: [] }
  const paths = readRecord(value, path, context)
  if (!paths) return { allow_changes: [], deny_changes: [] }
  rejectUnknownFields(paths, PATH_FIELDS, path, context)

  const allowChanges = readStringArray(
    paths.allow_changes,
    `${path}/allow_changes`,
    context,
    { required: false },
  )
  const denyChanges = readStringArray(
    paths.deny_changes,
    `${path}/deny_changes`,
    context,
    { required: false },
  )
  validatePathList(allowChanges, `${path}/allow_changes`, context)
  validatePathList(denyChanges, `${path}/deny_changes`, context)
  return { allow_changes: allowChanges, deny_changes: denyChanges }
}

function compileChecks(
  value: unknown,
  stepPath: string,
  context: CompileContext,
  field = 'checks',
): CanonicalCheckDefinition[] {
  const path = `${stepPath}/${field}`
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    addError(context, path, `${field} 必须是数组`)
    return []
  }

  const seen = new Set<string>()
  return value.map((rawCheck, index) => {
    const checkPath = `${path}/${index}`
    const check = readRecord(rawCheck, checkPath, context)
    if (!check) return emptyCheck()
    rejectUnknownFields(check, CHECK_FIELDS, checkPath, context)
    const id = readString(check.id, `${checkPath}/id`, context)
    if (id && !ID_PATTERN.test(id)) {
      addError(context, `${checkPath}/id`, `id 必须匹配 ${ID_PATTERN.source}`)
    }
    if (seen.has(id)) addError(context, `${checkPath}/id`, `重复的 check id: ${id}`)
    seen.add(id)

    const command = readStringArray(
      check.command,
      `${checkPath}/command`,
      context,
      { required: true, nonEmpty: true, nonEmptyStrings: true },
    )
    const cwd = readOptionalString(check.cwd, `${checkPath}/cwd`, context) ?? '.'
    validateRepoPath(cwd, true, `${checkPath}/cwd`, context)
    const timeoutSeconds = readPositiveInteger(
      check.timeout_seconds,
      `${checkPath}/timeout_seconds`,
      context,
    )
    const envAllow = readStringArray(
      check.env_allow,
      `${checkPath}/env_allow`,
      context,
      { required: false },
    )
    const required = readOptionalBoolean(
      check.required,
      `${checkPath}/required`,
      context,
    ) ?? true
    return {
      id,
      command,
      cwd,
      timeout_seconds: timeoutSeconds,
      env_allow: envAllow,
      required,
    }
  })
}

function compilePolicy(
  value: unknown,
  stepPath: string,
  context: CompileContext,
): CanonicalStepPolicy {
  const path = `${stepPath}/policy`
  const policy = readRecord(value, path, context)
  if (!policy) return emptyPolicy()
  rejectUnknownFields(policy, POLICY_FIELDS, path, context)

  return {
    timeout_seconds: readPositiveInteger(
      policy.timeout_seconds,
      `${path}/timeout_seconds`,
      context,
    ),
    repair_rounds: readOptionalNonNegativeInteger(
      policy.repair_rounds,
      `${path}/repair_rounds`,
      context,
    ) ?? 0,
    retries: readNonNegativeInteger(policy.retries, `${path}/retries`, context),
    approval_before_merge: readOptionalBoolean(
      policy.approval_before_merge,
      `${path}/approval_before_merge`,
      context,
    ) ?? false,
    // A write step that may legitimately find nothing to change (a docs sync
    // after an internal-only change). Present only when true, so workflows
    // that do not use it keep their hash.
    ...(readOptionalBoolean(policy.allow_no_changes, `${path}/allow_no_changes`, context) === true ? { allow_no_changes: true } : {}),
  }
}

async function resolveInstructionsFile(
  relativePath: string,
  stepPath: string,
  context: CompileContext,
): Promise<string | null> {
  const path = `${stepPath}/instructions_file`
  if (!context.fileResolver) {
    context.warnings.push({
      path,
      message: '未提供 fileResolver，已跳过 instructions_file 内容和 tracked blob 检查',
    })
    return null
  }

  try {
    const content = await context.fileResolver.readInstructionsFile(relativePath)
    if (content === undefined) {
      addError(context, path, 'instructions_file 不存在或不是 tracked blob')
      return null
    }
    return content
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addError(context, path, `读取 instructions_file 失败: ${message}`)
    return null
  }
}

function validateStepIds(steps: readonly CanonicalAgentStep[], context: CompileContext): void {
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    const path = `/spec/steps/${index}/id`
    if (step.id && !ID_PATTERN.test(step.id)) {
      addError(context, path, `id 必须匹配 ${ID_PATTERN.source}`)
    }
    if (seen.has(step.id)) addError(context, path, `重复的 step id: ${step.id}`)
    seen.add(step.id)
  })
}

function validateStepReferences(
  steps: readonly CanonicalAgentStep[],
  context: CompileContext,
): void {
  const ids = new Set(steps.map((step) => step.id))
  steps.forEach((step, stepIndex) => {
    const dependencies = new Set<string>()
    step.depends_on.forEach((dependency, dependencyIndex) => {
      const path = `/spec/steps/${stepIndex}/depends_on/${dependencyIndex}`
      if (!ids.has(dependency)) addError(context, path, `未知步骤: ${dependency}`)
      if (dependency === step.id) addError(context, path, '步骤不能依赖自身')
      if (dependencies.has(dependency)) addError(context, path, `重复依赖: ${dependency}`)
      dependencies.add(dependency)
    })

    step.consumes.forEach((selector, selectorIndex) => {
      const path = `/spec/steps/${stepIndex}/consumes/${selectorIndex}/step`
      if (!ids.has(selector.step)) addError(context, path, `未知步骤: ${selector.step}`)
      if (!dependencies.has(selector.step)) {
        addError(context, path, 'consumes.step 必须同时出现在 depends_on 中')
      }
    })
  })
}

function validateGraph(steps: readonly CanonicalAgentStep[], context: CompileContext): void {
  const indexById = new Map<string, number>()
  steps.forEach((step, index) => {
    if (!indexById.has(step.id)) indexById.set(step.id, index)
  })

  const indegree = steps.map((step) => step.depends_on.length)
  const downstream = steps.map(() => [] as number[])
  steps.forEach((step, stepIndex) => {
    step.depends_on.forEach((dependency) => {
      const dependencyIndex = indexById.get(dependency)
      if (dependencyIndex !== undefined) downstream[dependencyIndex]?.push(stepIndex)
    })
  })

  const ready = indegree
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count === 0)
    .map(({ index }) => index)
  let processed = 0
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const index = ready[cursor]
    if (index === undefined) continue
    processed += 1
    for (const child of downstream[index] ?? []) {
      indegree[child] = (indegree[child] ?? 0) - 1
      if (indegree[child] === 0) ready.push(child)
    }
  }

  if (processed === steps.length) return
  const cyclePaths = findCycleDependencyPaths(steps, indexById)
  for (const path of cyclePaths) addError(context, path, '步骤依赖形成环')
  indegree.forEach((count, index) => {
    if (count > 0) {
      addError(context, `/spec/steps/${index}/id`, '步骤无法从可执行根节点到达')
    }
  })
}

function findCycleDependencyPaths(
  steps: readonly CanonicalAgentStep[],
  indexById: Map<string, number>,
): string[] {
  const state = steps.map(() => 0)
  const stack: number[] = []
  const paths = new Set<string>()

  const visit = (index: number): void => {
    state[index] = 1
    stack.push(index)
    const step = steps[index]
    step?.depends_on.forEach((dependency, dependencyIndex) => {
      const target = indexById.get(dependency)
      if (target === undefined) return
      if (state[target] === 0) visit(target)
      if (state[target] === 1) {
        const cycleStart = stack.indexOf(target)
        for (const cycleIndex of stack.slice(cycleStart)) {
          const cycleStep = steps[cycleIndex]
          const nextIndex = cycleStep?.depends_on.findIndex((id) => {
            const nextTarget = indexById.get(id)
            return nextTarget !== undefined && stack.slice(cycleStart).includes(nextTarget)
          }) ?? -1
          if (nextIndex >= 0) paths.add(`/spec/steps/${cycleIndex}/depends_on/${nextIndex}`)
        }
        paths.add(`/spec/steps/${index}/depends_on/${dependencyIndex}`)
      }
    })
    stack.pop()
    state[index] = 2
  }

  steps.forEach((_, index) => {
    if (state[index] === 0) visit(index)
  })
  return [...paths].sort()
}

/**
 * The role-contract input a step's instructions satisfy: the instructions are
 * the task the step hands its role, which is what `task_description` in a
 * role's `contract.input.required` asks for.
 */
export const STEP_INSTRUCTIONS_FIELD = 'task_description'

function validateContracts(
  steps: readonly CanonicalAgentStep[],
  context: CompileContext,
  checker: ContractChecker,
  inputNames: readonly string[],
): void {
  const definitionsByStep = new Map<string, RoleDefinition>()
  const checkerSteps: WorkflowStepDef[] = steps.map((step) => {
    const role = context.roles.get(step.role)
    if (role) definitionsByStep.set(step.id, role)
    const provided = [
      ...inputNames,
      ...(step.instructions !== null || step.instructions_file_content !== null ? [STEP_INSTRUCTIONS_FIELD] : []),
    ]
    return { id: step.id, roleId: step.role, dependsOn: [...step.depends_on], provided }
  })
  const result = checker.checkWorkflow(checkerSteps, definitionsByStep)
  const stepIndexes = new Map(steps.map((step, index) => [step.id, index]))

  for (const error of result.errors) {
    const index = stepIndexes.get(error.stepId) ?? 0
    addError(context, `/spec/steps/${index}/role`, error.message)
  }
  for (const warning of result.warnings) {
    const index = stepIndexes.get(warning.stepId) ?? 0
    context.warnings.push({ path: `/spec/steps/${index}/role`, message: warning.message })
  }
}

function validateTemplates(
  value: string | undefined,
  path: string,
  inputs: Record<string, CanonicalWorkflowInput>,
  context: CompileContext,
): void {
  if (value === undefined) return
  const templatePattern = /\$\{\{([\s\S]*?)\}\}/g
  let match: RegExpExecArray | null
  let matches = 0
  while ((match = templatePattern.exec(value)) !== null) {
    matches += 1
    const expression = match[1]?.trim() ?? ''
    if (expression === 'run.id' || expression === 'step.id') continue
    const inputMatch = /^inputs\.([A-Za-z0-9_-]+)$/.exec(expression)
    if (inputMatch) {
      const inputName = inputMatch[1] ?? ''
      if (!(inputName in inputs)) addError(context, path, `未声明的模板输入: ${inputName}`)
      continue
    }
    addError(context, path, `不支持的模板变量: ${expression}`)
  }
  if ((value.match(/\$\{\{/g)?.length ?? 0) !== matches) {
    addError(context, path, '模板变量缺少结束标记 }}')
  }
}

function validatePathList(
  paths: string[],
  basePath: string,
  context: CompileContext,
): void {
  paths.forEach((path, index) => {
    validateRepoPath(path, false, `${basePath}/${index}`, context)
  })
}

function validateRepoPath(
  value: string,
  allowRoot: boolean,
  path: string,
  context: CompileContext,
): boolean {
  if (allowRoot && value === '.') return true
  const segments = value.split('/')
  const invalid = value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || /^[A-Za-z]:/.test(value)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  if (invalid) addError(context, path, '路径必须是规范化的仓库相对 POSIX 路径且不能包含 ..')
  return !invalid
}

function readRecord(
  value: unknown,
  path: string,
  context: CompileContext,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    addError(context, path, '必须是对象')
    return undefined
  }
  return value
}

function readString(value: unknown, path: string, context: CompileContext): string {
  if (typeof value !== 'string' || value.length === 0) {
    addError(context, path, '必须是非空字符串')
    return ''
  }
  return value
}

function readOptionalString(
  value: unknown,
  path: string,
  context: CompileContext,
): string | undefined {
  if (value === undefined) return undefined
  return readString(value, path, context)
}

function readOptionalBoolean(
  value: unknown,
  path: string,
  context: CompileContext,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    addError(context, path, '必须是布尔值')
    return undefined
  }
  return value
}

function readPositiveInteger(value: unknown, path: string, context: CompileContext): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    addError(context, path, '必须是正整数')
    return 0
  }
  return value
}

function readOptionalPositiveInteger(
  value: unknown,
  path: string,
  context: CompileContext,
): number | undefined {
  if (value === undefined) return undefined
  return readPositiveInteger(value, path, context)
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  context: CompileContext,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    addError(context, path, '必须是非负整数')
    return 0
  }
  return value
}

function readOptionalNonNegativeInteger(
  value: unknown,
  path: string,
  context: CompileContext,
): number | undefined {
  if (value === undefined) return undefined
  return readNonNegativeInteger(value, path, context)
}

function readNonNegativeNumber(
  value: unknown,
  path: string,
  context: CompileContext,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    addError(context, path, '必须是非负有限数字')
    return 0
  }
  return value
}

function readLiteral<T extends string>(
  value: unknown,
  expected: T,
  path: string,
  context: CompileContext,
): T {
  if (value !== expected) addError(context, path, `必须等于 ${expected}`)
  return expected
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  context: CompileContext,
): T | undefined {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addError(context, path, `必须是以下值之一: ${allowed.join(', ')}`)
    return undefined
  }
  return value as T
}

function readStringArray(
  value: unknown,
  path: string,
  context: CompileContext,
  options: { required: boolean; nonEmpty?: boolean; nonEmptyStrings?: boolean },
): string[] {
  if (value === undefined && !options.required) return []
  if (!Array.isArray(value)) {
    addError(context, path, '必须是字符串数组')
    return []
  }
  if (options.nonEmpty && value.length === 0) addError(context, path, '数组不能为空')
  const result: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string' || (options.nonEmptyStrings && item.length === 0)) {
      addError(context, `${path}/${index}`, '必须是非空字符串')
      return
    }
    result.push(item)
  })
  return result
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  basePath: string,
  context: CompileContext,
): void {
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      addError(context, `${basePath}/${escapePointer(field)}`, `未知字段: ${field}`)
    }
  }
}

function addError(context: CompileContext, path: string, message: string): void {
  context.errors.push({ path, message })
}

function invalidResult(context: CompileContext): WorkflowCompileResult {
  return { valid: false, errors: context.errors, warnings: context.warnings }
}

function emptySpec(): CanonicalWorkflowIR['spec'] {
  return {
    inputs: {},
    execution: { max_parallel: 0, failure_mode: 'stop_after_batch', max_run_seconds: 0 },
    workspace: defaultWorkspace(),
    budget: { max_total_tokens: 0, max_cost_usd: 0, on_unknown_price: 'reject' },
    steps: [],
  }
}

function defaultWorkspace(): CanonicalWorkflowWorkspace {
  return {
    strategy: 'git_worktree',
    dirty_policy: 'reject',
    merge_strategy: 'deterministic_cherry_pick',
    final_apply: 'approval_required',
  }
}

function emptyStep(): CanonicalAgentStep {
  return {
    id: '',
    kind: 'agent',
    role: '',
    mode: 'read',
    depends_on: [],
    instructions: null,
    instructions_file: null,
    instructions_file_content: null,
    consumes: [],
    paths: { allow_changes: [], deny_changes: [] },
    checks: [],
    policy: emptyPolicy(),
  }
}

function emptyPolicy(): CanonicalStepPolicy {
  return {
    timeout_seconds: 0,
    repair_rounds: 0,
    retries: 0,
    approval_before_merge: false,
  }
}

function emptyCheck(): CanonicalCheckDefinition {
  return {
    id: '',
    command: [],
    cwd: '.',
    timeout_seconds: 0,
    env_allow: [],
    required: true,
  }
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((child) => deepFreeze(child))
    Object.freeze(value)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
