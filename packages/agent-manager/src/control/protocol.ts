/**
 * Wire protocol for the per-process control endpoint.
 *
 * One Unix domain socket per `AgentManager` process lets any other process on
 * the machine forward `sendChat`/`sendCommand`/`close` to the process that
 * actually owns the agent's channel — the same trust boundary as the
 * live-agent registry (same OS user, same machine, filesystem permissions).
 *
 * Framing is deliberately simple: one JSON object per line, one request per
 * connection. Call volume is interactive chat, not a high-throughput RPC
 * surface, so a persistent multiplexed connection would add complexity this
 * traffic pattern never needs.
 */
import type { AgentCommand } from '../channel/types.js'

/** Control methods a process may forward to another process's `AgentManager`. */
export type ControlMethod = 'sendChat' | 'sendCommand' | 'close'

/** One forwarded request, serialized as a single line of JSON. */
export interface ControlRequest {
  method: ControlMethod
  agentId: string
  /** `sendChat` text. */
  text?: string
  /**
   * Caller's original timeout budget, forwarded so the owner applies the same
   * local timeout it would for a caller in its own process — the transport
   * hop must never invent a different deadline than the one the caller asked
   * for.
   */
  timeoutMs?: number
  /** `sendChat` scenario name, applied by the owner (it holds the role). */
  scenario?: string
  /** `sendCommand` payload. */
  command?: AgentCommand
}

/** Error shape carried back over the wire; reconstructed as `RemoteAgentError`. */
export interface ControlWireError {
  code: string
  message: string
  details?: unknown
}

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: ControlWireError }
