import { adaptLegacyRoleDocument, LegacyRoleFormatError } from './legacy-adapter.js'
import {
  DEFAULT_CHAT_TIMEOUT_MS,
  type RoleCollaboration,
  type RoleContract,
  type RoleDefinition,
  type RoleExecution,
  type RoleMetadata,
  type RoleScenario,
  type VerificationRule,
} from './types.js'

/** API versions that this role parser understands. */
const SUPPORTED_API_VERSIONS = ['dsh.orchestrator/v1alpha1'] as const

/** Raised when a role YAML document cannot be parsed into a role definition. */
export class RoleSchemaError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'RoleSchemaError'
  }
}

/** Validate a versioned document or adapt a legacy top-level role document. */
export function validateRoleDocument(raw: unknown, source: string): RoleDefinition {
  if (!isRecord(raw)) {
    throw new RoleSchemaError('角色文件必须是对象', source)
  }

  if ('api_version' in raw || 'kind' in raw || 'metadata' in raw) {
    return validateNewFormat(raw, source)
  }

  try {
    return adaptLegacyRoleDocument(raw)
  } catch (error) {
    const message = error instanceof LegacyRoleFormatError ? error.message : String(error)
    throw new RoleSchemaError(message, source)
  }
}

function validateNewFormat(doc: Record<string, unknown>, source: string): RoleDefinition {
  const apiVersion = requiredString(doc, 'api_version', source)
  if (!SUPPORTED_API_VERSIONS.includes(apiVersion as typeof SUPPORTED_API_VERSIONS[number])) {
    throw new RoleSchemaError(
      `不支持的 API 版本: ${apiVersion}，支持的版本: ${SUPPORTED_API_VERSIONS.join(', ')}`,
      source,
    )
  }

  const kind = requiredString(doc, 'kind', source)
  if (kind !== 'Role') {
    throw new RoleSchemaError(`期望 kind: Role，实际: ${kind}`, source)
  }

  const metadata = validateMetadata(doc.metadata, source)
  const systemPrompt = requiredString(doc, 'system_prompt', source)
  const capabilities = validateCapabilities(doc.capabilities, source)
  const execution = validateExecution(doc.execution, source)
  const scenarios = validateScenarios(doc.scenarios, source, 'scenarios')

  return {
    roleId: metadata.role_id,
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    systemPrompt,
    capabilities,
    execution,
    raw: doc,
    contract: doc.contract as RoleContract | undefined,
    verification: doc.verification as VerificationRule[] | undefined,
    collaboration: doc.collaboration as RoleCollaboration | undefined,
    annotations: metadata.annotations,
    ...(scenarios === undefined ? {} : { scenarios }),
  }
}

/** Scenario names: short, stable, safe to type on a command line. */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Validate a `scenarios` list (a role's, or a project layer's). Names must be
 * unique within the list; `when` and `guidance` are required because a
 * scenario nobody can recognise or follow is noise in every listing.
 */
export function validateScenarios(value: unknown, source: string, label: string): RoleScenario[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new RoleSchemaError(`${label} 必须是列表`, source)
  const seen = new Set<string>()
  return value.map((entry, index): RoleScenario => {
    const at = `${label}[${index}]`
    if (!isRecord(entry)) throw new RoleSchemaError(`${at} 必须是对象`, source)
    const name = requiredString(entry, 'name', source, `${at}.name`)
    if (!SCENARIO_NAME.test(name)) {
      throw new RoleSchemaError(`${at}.name 只能用小写字母、数字和 -（最长 64），实际: ${name}`, source)
    }
    if (seen.has(name)) throw new RoleSchemaError(`${at}.name 重复: ${name}`, source)
    seen.add(name)
    const title = optionalString(entry, 'title', source, `${at}.title`)
    const doneWhen = optionalString(entry, 'done_when', source, `${at}.done_when`)
    return {
      name,
      ...(title === undefined ? {} : { title }),
      when: requiredString(entry, 'when', source, `${at}.when`),
      guidance: requiredString(entry, 'guidance', source, `${at}.guidance`),
      ...(doneWhen === undefined ? {} : { doneWhen }),
    }
  })
}

function optionalString(record: Record<string, unknown>, field: string, source: string, label: string): string | undefined {
  if (record[field] === undefined) return undefined
  return requiredString(record, field, source, label)
}

function validateMetadata(value: unknown, source: string): RoleMetadata {
  if (!isRecord(value)) {
    throw new RoleSchemaError('metadata 必须是对象', source)
  }

  const metadata: RoleMetadata = {
    role_id: requiredString(value, 'role_id', source, 'metadata.role_id'),
    name: requiredString(value, 'name', source, 'metadata.name'),
    version: requiredString(value, 'version', source, 'metadata.version'),
    description: requiredString(value, 'description', source, 'metadata.description'),
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(metadata.version)) {
    throw new RoleSchemaError(
      `metadata.version 必须是 semver 格式，实际: ${metadata.version}`,
      source,
    )
  }

  if (value.annotations !== undefined) {
    if (!isRecord(value.annotations) || Object.values(value.annotations).some((annotation) => typeof annotation !== 'string')) {
      throw new RoleSchemaError('metadata.annotations 必须是字符串值对象', source)
    }
    metadata.annotations = value.annotations as Record<string, string>
  }

  return metadata
}

function validateCapabilities(value: unknown, source: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((capability) => typeof capability !== 'string')) {
    throw new RoleSchemaError('capabilities 必须是字符串数组', source)
  }
  return value
}

function validateExecution(value: unknown, source: string): RoleExecution {
  if (!isRecord(value)) {
    throw new RoleSchemaError('execution 必须是对象', source)
  }

  const harness = requiredString(value, 'harness', source, 'execution.harness')
  if (typeof value.keep_alive_after_task !== 'boolean') {
    throw new RoleSchemaError('execution.keep_alive_after_task 必须是布尔值', source)
  }

  if (value.interaction_mode !== undefined
    && value.interaction_mode !== 'headless'
    && value.interaction_mode !== 'interactive') {
    throw new RoleSchemaError(
      `execution.interaction_mode 必须是 'headless' 或 'interactive'，实际: ${String(value.interaction_mode)}`,
      source,
    )
  }
  if (value.show_window !== undefined && typeof value.show_window !== 'boolean') {
    throw new RoleSchemaError('execution.show_window 必须是布尔值', source)
  }
  if (value.chat_timeout_ms !== undefined
    && (typeof value.chat_timeout_ms !== 'number' || !Number.isInteger(value.chat_timeout_ms) || value.chat_timeout_ms <= 0)) {
    throw new RoleSchemaError('execution.chat_timeout_ms 必须是正整数', source)
  }

  return {
    harness,
    keepAliveAfterTask: value.keep_alive_after_task,
    chatTimeoutMs: value.chat_timeout_ms ?? DEFAULT_CHAT_TIMEOUT_MS,
    interactionMode: value.interaction_mode as RoleExecution['interactionMode'],
    showWindow: value.show_window as boolean | undefined,
    tools: value.tool_request ?? value.tools,
    sandbox: value.sandbox,
  }
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  source: string,
  label = field,
): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoleSchemaError(`${label} 必须是非空字符串`, source)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
