import { DEFAULT_SEND_CHAT_TIMEOUT_MS } from '../channel/types.js'
export type {
  ProjectLayer,
  RoleCollaboration,
  RoleContract,
  RoleDefinition,
  RoleDocument,
  RoleExecution,
  RoleHarness,
  RoleMetadata,
  RoleProvider,
  RoleScenario,
  RoleScenarioDocument,
  RoleSummary,
  VerificationRule,
} from '@dsh/spec'

/** Default `sendChat` timeout applied when neither role nor call site set one. */
export const DEFAULT_CHAT_TIMEOUT_MS = DEFAULT_SEND_CHAT_TIMEOUT_MS

/**
 * The turn timeout a role document itself declares, read from its source
 * (`execution.chat_timeout_ms`, or `chatTimeoutMs` in the legacy format);
 * `undefined` when it declares none.
 *
 * The loaders still fill `execution.chatTimeoutMs` with
 * `DEFAULT_CHAT_TIMEOUT_MS` when a role leaves it out — changing that would
 * change the hash of every role that does not declare one — so "declared or
 * defaulted" can only be told from `raw`. `PolicyResolver` needs exactly that
 * distinction: a declared value beats the project's `defaults.chatTimeoutMs`,
 * a defaulted one must not.
 */
export function declaredChatTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const execution = (raw as { execution?: unknown }).execution
  if (typeof execution !== 'object' || execution === null) return undefined
  const record = execution as Record<string, unknown>
  for (const value of [record.chat_timeout_ms, record.chatTimeoutMs]) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/** Default `keepAliveAfterTask` when a role file does not declare it. */
export const DEFAULT_KEEP_ALIVE_AFTER_TASK = true
