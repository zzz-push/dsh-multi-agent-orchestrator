/**
 * Error hierarchy for @dsh/agent-manager. All errors thrown by the public
 * API derive from {@link AgentManagerError} and carry a stable machine
 * readable `code` alongside the human readable message.
 */

/** Base error for everything thrown by @dsh/agent-manager. */
export class AgentManagerError extends Error {
  /** Stable machine-readable error code. */
  readonly code: string
  /** Extra structured detail attached to the error, when available. */
  readonly details?: unknown

  constructor(code: string, message: string, options: { cause?: unknown; details?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    if (options.details !== undefined) {
      this.details = options.details
    }
  }
}

/** The referenced agent id is unknown to this manager instance. */
export class AgentNotFoundError extends AgentManagerError {
  constructor(agentId: string) {
    super('agent-not-found', `No agent with id "${agentId}" is registered with this manager`)
  }
}

/** An agent with the generated id already exists (should not happen with UUIDs). */
export class AgentAlreadyExistsError extends AgentManagerError {
  constructor(agentId: string) {
    super('agent-already-exists', `An agent with id "${agentId}" is already registered`)
  }
}

/** The referenced role id could not be resolved by the RoleProvider. */
export class RoleNotFoundError extends AgentManagerError {
  constructor(roleId: string) {
    super('role-not-found', `No role with roleId "${roleId}" was found by the role provider`)
  }
}

/** No Channel adapter is registered for the requested harness. */
export class UnknownHarnessError extends AgentManagerError {
  constructor(harness: string, available: readonly string[]) {
    super(
      'unknown-harness',
      `No channel adapter registered for harness "${harness}" (available: ${available.join(', ')})`,
      { details: { harness, available } },
    )
  }
}

/** The child process could not be spawned. */
export class ChannelSpawnError extends AgentManagerError {
  constructor(harness: string, message: string, options: { cause?: unknown } = {}) {
    super('spawn-failed', `Failed to spawn ${harness} process: ${message}`, options)
  }
}

/** An operation was attempted on a channel whose process already exited. */
export class ChannelClosedError extends AgentManagerError {
  constructor(agentId: string, detail = 'the channel process has exited') {
    super('channel-closed', `Cannot use agent "${agentId}": ${detail}`)
  }
}

/** `sendChat` did not complete within the allotted time. */
export class ChannelTimeoutError extends AgentManagerError {
  /** How long the caller was willing to wait, in milliseconds. */
  readonly timeoutMs: number

  constructor(agentId: string, timeoutMs: number) {
    super(
      'timeout',
      `sendChat on agent "${agentId}" timed out after ${timeoutMs} ms`,
      { details: { agentId, timeoutMs } },
    )
    this.timeoutMs = timeoutMs
  }
}

/** `sendChat` was aborted through its `AbortSignal` before a reply arrived. */
export class ChannelAbortedError extends AgentManagerError {
  constructor(agentId: string) {
    super('aborted', `sendChat on agent "${agentId}" was aborted by its AbortSignal`)
  }
}

/** The sub-agent turn reported an error from the harness side. */
export class ChannelTurnError extends AgentManagerError {
  constructor(agentId: string, message: string) {
    super('turn-error', `Sub-agent "${agentId}" turn failed: ${message}`)
  }
}

/** A journal file could not be read, parsed or appended to. */
export class JournalError extends AgentManagerError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('journal-error', message, options)
  }
}

/** A role definition file exists but could not be parsed or validated. */
export class InvalidRoleError extends AgentManagerError {
  constructor(filePath: string, message: string) {
    super('invalid-role', `Invalid role file "${filePath}": ${message}`)
  }
}

/** A workflow Skill Pack exists but cannot be read or parsed safely. */
export class InvalidWorkflowSkillError extends AgentManagerError {
  constructor(packPath: string, message: string, options: { cause?: unknown } = {}) {
    super(
      'invalid-workflow-skill',
      `Invalid workflow Skill Pack "${packPath}": ${message}`,
      { ...options, details: { packPath } },
    )
  }
}

/**
 * The agent's owner process could not be
 * reached through its control socket — the socket file is gone, nothing is
 * listening, or it never answered before the caller's timeout. The stale
 * live-agent registry entry is pruned by whoever discovers this, the same
 * "any reader may clean up a dead entry" rule `FileLiveAgentRegistry.list()`
 * already applies to a dead `ownerPid`.
 */
/**
 * The agent is an arm of a running role comparison and only accepts
 * observation from outside its owner: a chat, command or close from another
 * process would change what the comparison measures.
 */
export class AgentObserveOnlyError extends AgentManagerError {
  constructor(agentId: string, detail = 'it is an arm of a running role comparison') {
    super('observe-only', `Agent "${agentId}" is observe-only: ${detail}`)
  }
}

export class AgentOwnerUnreachableError extends AgentManagerError {
  constructor(agentId: string, ownerPid: number, options: { cause?: unknown } = {}) {
    super(
      'agent-owner-unreachable',
      `Agent "${agentId}"'s owner process (pid ${ownerPid}) is no longer reachable`,
      { ...options, details: { agentId, ownerPid } },
    )
  }
}

/**
 * A request forwarded to an agent's owner process reached it, but no reply
 * came back: it timed out, the caller cancelled it, or the connection broke
 * off. Unlike {@link AgentOwnerUnreachableError} this says nothing about the
 * owner being gone, and the agent stays listed.
 */
export class AgentForwardError extends AgentManagerError {
  constructor(agentId: string, ownerPid: number, reason: string, options: { cause?: unknown } = {}) {
    super(
      'agent-forward-failed',
      `Request to agent "${agentId}" (owner pid ${ownerPid}) got no reply: ${reason}`,
      { ...options, details: { agentId, ownerPid, reason } },
    )
  }
}

/**
 * Reconstruction of an error thrown by the *owner* process's local call,
 * received back over the control socket. Carries the original `code` (so a
 * caller checking `error.code === 'agent-not-found'` behaves the same for a
 * local or a forwarded failure) but is never `instanceof` the original class
 * — the wire only carries `{code, message, details}`, not a class identity.
 */
export class RemoteAgentError extends AgentManagerError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, { details })
  }
}
