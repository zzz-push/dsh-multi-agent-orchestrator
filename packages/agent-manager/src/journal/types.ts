/**
 * Journal event vocabulary shared by the agent-manager journal and by every
 * `Channel` adapter. The journal is the *only* trusted source of truth for
 * sub-agent conversation history: CLI-internal session files (e.g.
 * `~/.codex/sessions/*.jsonl`) are implementation details and must never be
 * read as a core data source.
 */

/**
 * Kind of a journal event. Kinds are stable identifiers used by
 * `readConversation` filtering; payload shapes per kind are documented on
 * {@link JournalEvent}.
 */
export type JournalEventKind =
  | 'agent.spawned'
  | 'agent.exited'
  | 'agent.window_opened'
  | 'agent.window_closed'
  | 'agent.interaction_requested'
  | 'agent.interaction_completed'
  | 'agent.activity'
  | 'agent.provider_retry'
  | 'policy.violation'
  | 'verification.completed'
  | 'verification.error'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'command.sent'
  | 'chat.sent'
  | 'chat.replied'
  | 'error'

/**
 * Role of the party that produced a journal event.
 *
 * - `'user'` — input from the main agent (or its delegate).
 * - `'assistant'` — output produced by the sub-agent.
 * - `'system'` — lifecycle facts observed by agent-manager itself
 *   (spawn, exit, errors).
 */
export type JournalEventRole = 'user' | 'assistant' | 'system'

/** Well-known tool-call / tool-result payloads, as emitted by adapters. */
export interface ToolCallPayload {
  /** Tool id assigned by the harness (e.g. Claude `toolu_...` or codex item id). */
  toolUseId: string
  /** Tool name (e.g. `Bash`, `commandExecution`). */
  name: string
  /** Tool input as reported by the harness; shape is harness-specific. */
  input?: unknown
}

export interface ToolResultPayload {
  /** Tool id assigned by the harness; matches {@link ToolCallPayload.toolUseId}. */
  toolUseId: string
  /** Whether the harness reported the tool call as failed. */
  isError: boolean
  /** Tool output as reported by the harness; shape is harness-specific. */
  content?: unknown
}

/** Payload of `message` / `chat.sent` / `chat.replied` events. */
export interface MessagePayload {
  /** Message text. */
  text: string
  /** Harness-native message id when one exists (e.g. Claude `msg_...`). */
  messageId?: string
}

/** Payload of `command.sent` events. */
export interface CommandSentPayload {
  /** Structured command kind, e.g. `task`. */
  commandKind: string
  /** Structured command payload exactly as submitted (harness-agnostic). */
  payload: unknown
  /** Instruction text handed to the sub-agent. */
  text: string
}

/** Payload of `agent.spawned` events. */
export interface AgentSpawnedPayload {
  /** Role id the agent was spawned with. */
  roleId: string
  /** `metadata.version` of the role definition at spawn time. */
  roleVersion: string
  /**
   * Content hash of the role definition at spawn time, from
   * `computeRoleHash()`. This — not `roleVersion` — is what identifies which
   * role content a run actually used: a version string can be left unbumped
   * after an edit, the hash cannot.
   */
  roleHash: string
  /**
   * Content hash of the project layer on top of the role, when the project
   * has one (`computeProjectLayerHash()`). Not part of `roleHash`: the same
   * role hashes the same in every project; this says what the project added.
   */
  projectLayerHash?: string
  /** Harness behind the channel (e.g. `claude-code`). */
  harness: string
  /** Third-party tools (MCP server names) the agent was given: declared by the role, allowed and defined by the project. */
  mcpServers?: string[]
  /** Harness-native session identifier, when known at spawn time. */
  harnessSessionId?: string
  /** Working directory of the child process. */
  cwd: string
  /** Whether the sub-agent process is kept alive after each task turn. */
  keepAliveAfterTask: boolean
}

/** Payload of `agent.exited` events. */
export interface AgentExitedPayload {
  /** Process exit code; `null` when the process was killed by a signal. */
  exitCode: number | null
  /** Signal that killed the process, when applicable. */
  signal: string | null
  /** Harness-native session identifier, when known. */
  harnessSessionId?: string
}

/**
 * Payload of `agent.activity` events: the harness saying it is working when
 * nothing visible (a message, a tool call) is happening — the evidence that
 * tells "the model is thinking" apart from "the provider is stuck".
 *
 * What each harness can actually report was established by probing both:
 * - claude-code streams `system/thinking_tokens` about once a second while
 *   the model thinks → `{ activity: 'thinking', phase: 'progress', tokens }`,
 *   throttled by the channel to one event per heartbeat interval.
 * - codex app-server v2 sends nothing at all while the model reasons; it
 *   only opens and closes a `reasoning` item → `{ activity: 'reasoning',
 *   phase: 'started' | 'completed' }`. The silence between the two is
 *   reasoning, unless it ends in a provider retry.
 */
export interface AgentActivityPayload {
  activity: 'thinking' | 'reasoning'
  /** `progress` is a heartbeat; `started`/`completed` bracket a span whose middle is silent. */
  phase: 'started' | 'progress' | 'completed'
  /** Harness-reported size so far, when it reports one (claude's estimated thinking tokens). */
  tokens?: number
}

/**
 * Payload of `agent.provider_retry` events: the harness reports that a model
 * request failed and will be retried — positive evidence of an environment
 * problem (claude-code `system/api_retry`, codex `error` with `willRetry`).
 */
export interface ProviderRetryPayload {
  message: string
  attempt?: number
  maxRetries?: number
  /** How long the harness waits before retrying. */
  delayMs?: number
  /** HTTP status of the failed request, when known. */
  status?: number | null
  /** How long the harness had waited for a response before giving up on it, when it says. */
  waitedMs?: number
}

/** Payload of `error` events. */
export interface ErrorPayload {
  /** Error code (e.g. `timeout`, `aborted`, `spawn-failed`). */
  code: string
  /** Human-readable error message. */
  message: string
}

/**
 * One immutable record of sub-agent activity.
 *
 * `seq` is a strictly increasing, agent-manager-owned sequence number (not a
 * timestamp) and doubles as the pagination cursor for `readConversation`.
 * Multiple events may share the same millisecond `timestamp`; only `seq`
 * guarantees a total order.
 */
export interface JournalEvent {
  /** Monotonic sequence number assigned by the journal writer (cursor). */
  seq: number
  /** Epoch milliseconds at which the event was appended. */
  timestamp: number
  /** agent-manager-generated agent id this event belongs to. */
  agentId: string
  /** Event kind. */
  kind: JournalEventKind
  /** Producing party. */
  role: JournalEventRole
  /** Kind-specific payload; see the `*Payload` interfaces in this module. */
  payload: unknown
}

/**
 * Event handed from a `Channel` adapter to its `onEvent` sink. The journal
 * writer attaches `seq`, `timestamp` and `agentId` itself.
 */
export interface ChannelEvent {
  /** Stable event vocabulary value. */
  kind: JournalEventKind
  /** Party that produced the event. */
  role: JournalEventRole
  /** Harness-agnostic event detail. */
  payload: unknown
}

/** A page of conversation history, ordered by ascending `seq`. */
export interface ReadConversationResult {
  /** Events matching the query, oldest first. */
  items: JournalEvent[]
  /**
   * Opaque cursor to pass as `after` for the next page; present only when
   * more matching events exist beyond this page.
   */
  nextCursor?: string
}

/** Options accepted by `readConversation`. */
export interface ReadConversationOptions {
  /** agent-manager-generated agent id. */
  agentId: string
  /**
   * Resume cursor from a previous page (`nextCursor`). Events with
   * `seq <= after` are skipped. This is a sequence cursor, **not** a
   * timestamp: same-millisecond event bursts must not lose or duplicate
   * events.
   */
  after?: string
  /**
   * Exclusive upper bound on `seq` (plain number). Useful for scanning a
   * bounded window of history without a cursor.
   */
  before?: number
  /** Restrict to events produced by these parties. */
  roles?: Array<'user' | 'assistant'>
  /** Restrict to these event kinds. */
  kinds?: JournalEventKind[]
  /** Maximum number of events per page. Defaults to 20. */
  limit?: number
}
