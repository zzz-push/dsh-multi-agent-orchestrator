import {
  DEFAULT_CHAT_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_AFTER_TASK,
  type RoleDefinition,
  type RoleExecution,
} from './types.js'

export class LegacyRoleFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LegacyRoleFormatError'
  }
}

/** Convert the pre-versioned, top-level role document format into a role definition. */
export function adaptLegacyRoleDocument(raw: Record<string, unknown>): RoleDefinition {
  return {
    roleId: requiredString(raw, 'role_id'),
    name: requiredString(raw, 'name'),
    version: optionalString(raw, 'version') ?? '0.0.0',
    description: optionalText(raw, 'description') ?? '',
    systemPrompt: optionalText(raw, 'system_prompt') ?? '',
    capabilities: optionalStringArray(raw, 'capabilities') ?? [],
    execution: normalizeLegacyExecution(raw.execution),
    raw,
  }
}

function normalizeLegacyExecution(value: unknown): RoleExecution {
  if (value === undefined) {
    return {
      harness: 'claude-code',
      keepAliveAfterTask: DEFAULT_KEEP_ALIVE_AFTER_TASK,
      chatTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    }
  }

  const execution = asRecord(value, 'execution 必须是对象')
  return {
    harness: optionalString(execution, 'harness') ?? 'claude-code',
    keepAliveAfterTask: optionalBoolean(execution, 'keepAliveAfterTask')
      ?? optionalBoolean(execution, 'keep_alive_after_task')
      ?? DEFAULT_KEEP_ALIVE_AFTER_TASK,
    chatTimeoutMs: optionalPositiveInteger(execution, 'chatTimeoutMs')
      ?? optionalPositiveInteger(execution, 'chat_timeout_ms')
      ?? DEFAULT_CHAT_TIMEOUT_MS,
    interactionMode: optionalInteractionMode(execution, 'interactionMode')
      ?? optionalInteractionMode(execution, 'interaction_mode'),
    showWindow: optionalBoolean(execution, 'showWindow')
      ?? optionalBoolean(execution, 'show_window'),
    tools: execution.tool_request ?? execution.tools,
    sandbox: execution.sandbox,
  }
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是非空字符串`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是非空字符串`)
  }
  return value
}

function optionalText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是字符串`)
  }
  return value
}

function optionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是字符串数组`)
  }
  return value
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是布尔值`)
  }
  return value
}

function optionalPositiveInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是正整数`)
  }
  return value
}

function optionalInteractionMode(
  record: Record<string, unknown>,
  field: string,
): 'headless' | 'interactive' | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (value !== 'headless' && value !== 'interactive') {
    throw new LegacyRoleFormatError(`旧格式${field} 必须是 'headless' 或 'interactive'`)
  }
  return value
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyRoleFormatError(message)
  }
  return value as Record<string, unknown>
}
