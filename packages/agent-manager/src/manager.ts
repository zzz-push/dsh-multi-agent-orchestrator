import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { AgentAlreadyExistsError, AgentForwardError, AgentNotFoundError, AgentObserveOnlyError, AgentOwnerUnreachableError, RoleNotFoundError, UnknownHarnessError } from './errors.js'
import type {
  AgentCommand,
  Channel,
  ChannelOpenOptions,
  ChannelSession,
  ChatReply,
  SendChatOptions,
} from './channel/types.js'
import { DEFAULT_SEND_CHAT_TIMEOUT_MS } from './channel/types.js'
import { ControlUnreachableError, requestControl } from './control/client.js'
import { ControlServer, defaultControlSocketDir } from './control/server.js'
import type { ControlRequest } from './control/protocol.js'
import type { JournalEvent, ReadConversationOptions, ReadConversationResult } from './journal/types.js'
import { JournalReader } from './journal/reader.js'
import { JournalWriter, type JournalLogger } from './journal/writer.js'
import {
  FileLiveAgentRegistry,
  defaultLiveAgentRegistryDir,
  type EvaluationContext,
  type LiveAgentEntry,
  type LiveAgentRegistry,
} from './registry/live-agents.js'
import type { RoleDefinition, RoleProvider, RoleSummary } from './role/types.js'
import { declaredChatTimeoutMs } from './role/types.js'
import { computeRoleHash } from './role/role-hash.js'
import { composeScenarioTask, composeSystemPrompt, findScenario } from './role/project-layer.js'
import { PolicyResolver, expandMcpServerLaunch, loadProjectPolicy } from './policy/index.js'
import { PolicyError, type ProjectPolicy } from './policy/types.js'
import { OutputVerifier, type VerificationResult } from '@dsh/core'

/**
 * Forwarding a `sendCommand`/`close` round trip has no role-specific budget
 * of its own (unlike `sendChat`, which carries the role's `chatTimeoutMs`),
 * so it borrows `sendChat`'s default rather than inventing an unrelated
 * number. `sendCommand` in particular can run a full harness turn before
 * resolving (see `Channel.sendCommand`), so this needs to be generous.
 */
const DEFAULT_FORWARD_TIMEOUT_MS = DEFAULT_SEND_CHAT_TIMEOUT_MS

/**
 * {@link ChatReply} plus the outcome of the role's own declared `verification`
 * rules, when it declared any.
 *
 * Before this field existed, a caller had no way to know — short of reading
 * the journal — whether the role's own checks thought this reply was
 * adequate; an intent-only
 * reply with zero tool calls as "done" because nothing consulted the
 * `verification.completed` event the role's own rules had already produced.
 * `undefined` means either the role declares no `verification` rules, or the
 * verifier itself failed to run (a bug in the checker, not a failed check) —
 * a caller must not treat `undefined` as "passed".
 */
export interface AgentChatReply extends ChatReply {
  verification?: { passed: boolean; results: VerificationResult[] }
}

/** Options used when constructing an {@link AgentManager}. */
export interface AgentManagerOptions {
  /** Role source used to resolve `spawn` requests. */
  roleProvider: RoleProvider
  /** Append-only event journal path. */
  journalFile: string
  /** Built-in and community channel adapters. */
  channels: readonly Channel[]
  /** Default child working directory. */
  cwd?: string
  /** Optional Cordis-compatible logger. */
  logger?: JournalLogger
  /**
   * Machine-level MCP server launch definitions merged under the project
   * policy's own. Default `~/.dsh/mcp-servers.yaml`; `false` reads none.
   */
  mcpServersFile?: string | false
  /** Injectable id generator for deterministic tests. */
  idFactory?: () => string
  /**
   * Where live agents are advertised to other processes (see
   * {@link LiveAgentRegistry}). Defaults to the shared per-user directory so
   * every `AgentManager` on the machine — host plugin, demo, dispatch script —
   * is discoverable by a DSH page bound to its project; `false` opts out.
   */
  liveAgentRegistryDir?: string | false
  /**
   * Directory holding this process's control socket, used only
   * when `liveAgentRegistryDir` is enabled — advertising an agent to other
   * processes without a way for them to drive it would defeat the point.
   * Defaults to the shared per-user directory, matching
   * `liveAgentRegistryDir`'s default.
   */
  controlSocketDir?: string
  /**
   * Mark every agent this manager spawns as an arm of a running role
   * comparison: advertised with this context (DSH shows them in an
   * "评估中" group, matched to `workspace` rather than to their temporary
   * cwd), and observe-only for other processes — the control socket refuses
   * forwarded chat, commands and close. The owner itself (the comparison's
   * executor) drives the agent as usual.
   */
  evaluation?: EvaluationContext
}

/** Interaction mode for agent execution. */
export type InteractionMode = 'headless' | 'interactive'

/** Options for one child-agent spawn. */
/** Options for {@link AgentManager.sendChat}: the channel's, plus a scenario to apply. */
export interface AgentSendChatOptions extends SendChatOptions {
  /**
   * Name of one of the role's scenarios (its own or its project layer's).
   * That scenario's guidance goes in front of this task only. An unknown
   * name rejects with `UnknownScenarioError` before anything is sent.
   */
  scenario?: string
}

export interface SpawnAgentOptions {
  /** Stable role id resolved through the configured provider. */
  roleId: string
  /** Optional child working directory override. */
  cwd?: string
  /** Optional environment overlay. */
  env?: Record<string, string>
  /** Optional caller-selected harness session id (Claude only). */
  harnessSessionId?: string
  /** Interaction mode: headless (default) or interactive. */
  interactionMode?: InteractionMode
  /** Whether to show window when spawning (for interactive mode). */
  showWindow?: boolean
  /**
   * Sandbox mode for this child, overriding the role's own
   * `execution.sandbox`. Goes through the PolicyResolver exactly like the
   * role's declaration would, so a caller cannot grant more than the project
   * policy allows. Meant for the case where the sandbox is a property of the
   * task rather than of the role — a role-eval manifest, for instance, must
   * give every arm the same environment without editing either role.
   */
  sandbox?: string
  /**
   * Harness for this child, overriding the role's own `execution.harness`.
   * Resolved by the PolicyResolver like the role's declaration (a harness the
   * project does not allow is downgraded and journaled as a violation). Same
   * use case as {@link SpawnAgentOptions.sandbox}: running every arm of a
   * comparison on one harness without editing — and re-hashing — the roles.
   */
  harness?: string
}

/** Public identity and lifecycle information for one managed child. */
export interface AgentHandle {
  /** Manager-generated primary key. */
  readonly agentId: string
  /** Role used to construct the child. */
  readonly roleId: string
  /**
   * `metadata.version` of the role definition this child was spawned from
   *. Always present on this manager's own children; absent only on
   * an agent discovered from another process running an agent-manager that
   * predates this field. The durable record is the `agent.spawned` journal
   * event, where both fields are required.
   */
  readonly roleVersion?: string
  /**
   * Content hash of the role definition this child was spawned from
   *, from `computeRoleHash()`. Same presence rule as
   * {@link AgentHandle.roleVersion}.
   */
  readonly roleHash?: string
  /**
   * Content hash of the project layer the agent was spawned with, when the
   * project has one for this role. The role hash says which role ran; this
   * says which project layer ran on top of it.
   */
  readonly projectLayerHash?: string
  /** Selected channel/harness id. */
  readonly harness: string
  /** Harness-native session id, once the channel opens. */
  readonly harnessSessionId: string
  /**
   * Absolute working directory the child was started in. This is the key the
   * Harness Agent window binds on: a DSH page shows the agents whose cwd sits
   * inside the Workspace it is currently looking at.
   */
  readonly cwd: string
  /** Whether the role asks the manager to retain the process after commands. */
  readonly keepAliveAfterTask: boolean
  /** Interaction mode for this agent. */
  readonly interactionMode: InteractionMode
  /** Whether the Agent requests a visible Harness UI window. */
  readonly showWindow: boolean
  /** Optional native window handle supplied by a Channel implementation. */
  readonly windowHandle?: string
  /** OS pid of the underlying harness child process, when the Channel exposes one. */
  readonly pid?: number
  /** Present when the agent is an arm of a running role comparison. */
  readonly evaluation?: EvaluationContext
}

/** Lifecycle state returned by {@link AgentManager.list}. */
export type AgentStatus = 'opening' | 'open' | 'closing' | 'exited' | 'failed'

/** Diagnostic view of a managed child. */
export interface AgentInfo extends AgentHandle {
  readonly status: AgentStatus
  /** Epoch ms of the latest started turn, when one is active or was last active. */
  readonly lastTurnStartedAt?: number
  /** Latest harness turn id observed by the channel. */
  readonly lastTurnId?: string
}

/**
 * An agent visible to this process: either one of its own children or one
 * another `AgentManager` on this machine advertised through the live-agent
 * registry. External agents can be observed (journal reads) but not driven —
 * their channel lives in the owner process.
 */
export interface DiscoveredAgent extends AgentInfo {
  /** False for this manager's own children. */
  readonly external: boolean
  /** Pid of the process that owns the channel. */
  readonly ownerPid: number
}

interface AgentRecord {
  handle: AgentHandle
  role: RoleDefinition
  channel: Channel
  session: ChannelSession
  status: AgentStatus
  tail: Promise<void>
  closePromise?: Promise<void>
  lastTurnStartedAt?: number
  lastTurnId?: string
  /**
   * Turn timeout resolved at spawn (role declaration → project policy
   * `defaults.chatTimeoutMs` → built-in default; behavior). `sendChat` uses
   * it when the caller sets none.
   */
  chatTimeoutMs: number
}

/**
 * Facade for child-agent lifecycle, channel selection and journal queries.
 *
 * `agentId` values are generated here, never borrowed from Claude session ids
 * or Codex thread ids. Channel operations are serialized per agent while the
 * journal sink remains synchronous and independent of the operation promise.
 */
export class AgentManager {
  private readonly roleProvider: RoleProvider
  private readonly cwd: string
  private readonly logger?: JournalLogger
  private readonly idFactory: () => string
  private readonly channels = new Map<string, Channel>()
  private readonly records = new Map<string, AgentRecord>()
  private readonly writer: JournalWriter
  private readonly reader: JournalReader
  private readonly journalFile: string
  private readonly registry?: LiveAgentRegistry
  private readonly externalReaders = new Map<string, JournalReader>()
  private disposed = false
  private policyResolver?: PolicyResolver
  private projectPolicy?: ProjectPolicy
  private verifier?: OutputVerifier
  /** Random per-process id; see `LiveAgentEntry.ownerGeneration`. */
  private readonly ownerGeneration: string
  /** Undefined exactly when `registry` is undefined — no registry, no point advertising a control endpoint. */
  private readonly controlSocketPath?: string
  private controlServer?: ControlServer
  private controlServerReady?: Promise<void>
  private readonly evaluation?: EvaluationContext
  private readonly mcpServersFile?: string | false

  constructor(options: AgentManagerOptions) {
    this.roleProvider = options.roleProvider
    this.mcpServersFile = options.mcpServersFile
    this.cwd = path.resolve(options.cwd ?? process.cwd())
    this.logger = options.logger
    this.idFactory = options.idFactory ?? randomUUID
    this.journalFile = path.resolve(options.journalFile)
    this.evaluation = options.evaluation
    this.writer = new JournalWriter({ file: this.journalFile, logger: options.logger })
    this.reader = new JournalReader({ file: this.journalFile, logger: options.logger })
    if (options.liveAgentRegistryDir !== false) {
      this.registry = new FileLiveAgentRegistry({
        dir: options.liveAgentRegistryDir ?? defaultLiveAgentRegistryDir(),
        logger: options.logger,
      })
    }
    // Generated unconditionally (cheap) even when there is no registry, so
    // this field is never in a partially-initialized state. Short (not a
    // UUID) because it also names this process's control socket file, and
    // Unix domain socket paths are capped at ~104 bytes (macOS) / 108
    // (Linux) — 16 hex chars leaves comfortable room for the directory.
    this.ownerGeneration = randomBytes(8).toString('hex')
    this.controlSocketPath = this.registry === undefined
      ? undefined
      : path.join(options.controlSocketDir ?? defaultControlSocketDir(), `${this.ownerGeneration}.sock`)
    for (const channel of options.channels) this.registerChannel(channel)
  }

  /** Registry this manager advertises through, when enabled. */
  get liveAgentRegistry(): LiveAgentRegistry | undefined {
    return this.registry
  }

  /** Register one channel adapter under its harness id. */
  registerChannel(channel: Channel): void {
    this.ensureLive()
    if (this.channels.has(channel.harness)) {
      throw new Error(`A channel for harness "${channel.harness}" is already registered`)
    }
    this.channels.set(channel.harness, channel)
  }

  /**
   * Resolve a role, generate an `agentId`, spawn its channel and journal the
   * lifecycle event.
   */
  async spawn(options: SpawnAgentOptions | string): Promise<AgentHandle> {
    this.ensureLive()
    const request: SpawnAgentOptions = typeof options === 'string' ? { roleId: options } : options
    const role = await this.roleProvider.get(request.roleId)
    if (role === undefined) throw new RoleNotFoundError(request.roleId)
    //  在任何副作用之前就把"这次用的是哪一版角色"算出来。角色内容一旦
    // 进了 journal 的 agent.spawned 事件，之后角色文件再怎么改都不影响这条记录。
    const roleHash = computeRoleHash(role)

    const agentId = this.newAgentId()
    const cwd = path.resolve(request.cwd ?? this.cwd)

    // Load and apply policy (懒加载)
    if (!this.policyResolver) {
      this.projectPolicy = await loadProjectPolicy(cwd, this.mcpServersFile === undefined ? {} : { mcpServersFile: this.mcpServersFile })
      this.policyResolver = new PolicyResolver(this.projectPolicy)
    }

    // 验证权限（调用方的 sandbox / harness 覆盖也走同一条校验路径）
    const permissions = this.policyResolver.resolve(
      {
        ...role.execution,
        ...(request.sandbox === undefined ? {} : { sandbox: request.sandbox }),
        ...(request.harness === undefined ? {} : { harness: request.harness }),
      },
      role.roleId,
      { chatTimeoutMs: declaredChatTimeoutMs(role.raw) },
    )

    // 记录策略违规（如果有）
    if (!permissions.allowed && permissions.violations) {
      this.logger?.warn(
        `Role "${role.roleId}" has ${permissions.violations.length} policy violation(s):`
      )
      for (const violation of permissions.violations) {
        this.logger?.warn(
          `  - ${violation.type}: "${violation.requested}" - ${violation.reason}`
        )
      }
      // 写入 journal
      this.safeJournal(agentId, 'policy.violation', 'system', {
        roleId: role.roleId,
        violations: permissions.violations,
      })
    }

    // 策略在某一类上什么都不允许：没有可降级的值，这个 agent 不能启动
    if (permissions.refused !== undefined) {
      throw new PolicyError(
        `Role "${role.roleId}" cannot start under the project policy: ${permissions.refused.map((violation) => violation.reason).join('; ')}`,
        permissions.refused,
      )
    }

    // 使用解析后的 harness（可能被策略降级）
    const channel = this.channels.get(permissions.harness)
    if (channel === undefined) {
      throw new UnknownHarnessError(permissions.harness, [...this.channels.keys()])
    }

    // Determine interaction mode: request > permissions > default
    const interactionMode = request.interactionMode ?? permissions.execution.interactionMode
    const showWindow = request.showWindow ??
      (interactionMode === 'interactive' && role.execution.showWindow === true)

    const recordRef = {
      role,
      channel,
      status: 'opening' as AgentStatus,
    }
    const openingEvents: Array<{ kind: JournalEvent['kind']; role: JournalEvent['role']; payload: unknown }> = []
    let opening = true
    let session: ChannelSession
    try {
      session = await channel.open({
        agentId,
        cwd,
        harnessSessionId: request.harnessSessionId,
        systemPrompt: composeSystemPrompt(role),
        env: request.env,
        // 使用解析后的工具和沙箱配置（已经过策略验证）
        tools: permissions.toolRequest ?? role.execution.tools,
        // Only what the policy granted: the request is already part of what
        // was resolved, and falling back to it would undo a refusal.
        sandbox: permissions.sandbox,
        // Exactly the third-party tools the role declared and the project
        // provides — possibly none. Always passed, so the channel never falls
        // back to whatever MCP servers the harness would load on its own.
        mcpServers: Object.fromEntries(Object.entries(permissions.mcpServers).map(([name, launch]) => [name, expandMcpServerLaunch(launch, { projectRoot: this.cwd, agentCwd: cwd })])),
        showWindow,
        windowTitle: `Agent ${agentId} - ${role.name}`,
        onEvent: (event) => {
          if (opening) openingEvents.push(event)
          else this.onChannelEvent(agentId, event)
        },
        onTurnStarted: (turnId) => {
          const record = this.records.get(agentId)
          if (record !== undefined) {
            record.lastTurnStartedAt = Date.now()
            record.lastTurnId = turnId
          }
        },
      } satisfies ChannelOpenOptions)
    } catch (error) {
      opening = false
      for (const event of openingEvents) this.onChannelEvent(agentId, event)
      this.safeJournal(agentId, 'error', 'system', {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'spawn-failed',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const handle: AgentHandle = Object.freeze({
      agentId,
      roleId: role.roleId,
      roleVersion: role.version,
      roleHash,
      ...(role.projectLayer === undefined ? {} : { projectLayerHash: role.projectLayer.hash }),
      harness: channel.harness,
      harnessSessionId: session.sessionId,
      cwd,
      keepAliveAfterTask: role.execution.keepAliveAfterTask,
      interactionMode,
      showWindow,
      windowHandle: session.windowHandle,
      pid: session.pid,
      evaluation: this.evaluation,
    })
    const record: AgentRecord = {
      ...recordRef,
      handle,
      session,
      tail: Promise.resolve(),
      chatTimeoutMs: permissions.execution.chatTimeoutMs,
    }
    this.records.set(agentId, record)
    // 记录解析后的权限信息
    this.safeJournal(agentId, 'agent.spawned', 'system', {
      roleId: role.roleId,
      roleVersion: role.version,
      roleHash,
      ...(role.projectLayer === undefined ? {} : { projectLayerHash: role.projectLayer.hash }),
      harness: permissions.harness, // 使用解析后的 harness
      mcpServers: Object.keys(permissions.mcpServers),
      harnessSessionId: session.sessionId,
      cwd,
      keepAliveAfterTask: permissions.execution.keepAliveAfterTask,
      chatTimeoutMs: permissions.execution.chatTimeoutMs,
      interactionMode,
      showWindow,
      windowHandle: session.windowHandle,
      pid: session.pid,
      policyApplied: !permissions.allowed, // 标记是否有策略调整
    })
    record.status = 'open'
    opening = false
    await this.ensureControlServer()
    this.advertise(handle, record.chatTimeoutMs)
    for (const event of openingEvents) this.onChannelEvent(agentId, event)
    this.logger?.info(`Agent ${agentId} spawned with role ${role.roleId} via ${channel.harness} (${interactionMode} mode)`)
    return handle
  }

  /** Alias retained for callers that prefer an explicit verb. */
  spawnAgent(options: SpawnAgentOptions | string): Promise<AgentHandle> {
    return this.spawn(options)
  }

  /**
   * Send a structured control instruction to one managed agent.
   *
   * **For control, not for dispatching work**: the reply text is
   * discarded and the role's declared `verification` rules do not run, so
   * resolving only means the turn ended. To hand an agent a task and learn
   * whether it was done, use {@link AgentManager.sendChat}, which returns
   * the reply with the role's own check results attached — that is what the
   * governed pipeline's executor uses.
   *
   * An `agentId` this process does not own is forwarded to its owner over
   * the control socket instead of throwing immediately — see
   * `forwardToOwner`.
   */
  sendCommand(agentId: string, command: AgentCommand): Promise<void> {
    this.ensureLive()
    const record = this.records.get(agentId)
    if (record === undefined) {
      return this.forwardToOwner(agentId, { method: 'sendCommand', agentId, command }, DEFAULT_FORWARD_TIMEOUT_MS) as Promise<void>
    }
    return this.enqueue(record, async () => {
      this.ensureOpen(record)
      try {
        await record.channel.sendCommand(record.session, command)
      } finally {
        if (!record.role.execution.keepAliveAfterTask) await this.closeRecord(record)
      }
    })
  }

  /**
   * Send free text and await one complete reply.
   *
   * An `agentId` this process does not own is forwarded to its owner over
   * the control socket; the owner runs its own verification (if
   * the role declares any) before the reply crosses back, so no duplicate
   * verification happens on the forwarding side.
   */
  async sendChat(agentId: string, text: string, options?: AgentSendChatOptions): Promise<AgentChatReply> {
    this.ensureLive()
    const record = this.records.get(agentId)
    if (record === undefined) {
      // A caller that names no timeout gets the owner's (the role's, or the
      // project default), not one invented here: the timeout is
      // forwarded only when the caller set it, and this side waits as long
      // as the owner advertised it would.
      const result = await this.forwardToOwner(agentId, {
        method: 'sendChat',
        agentId,
        text,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.scenario === undefined ? {} : { scenario: options.scenario }),
      }, (entry) => options?.timeoutMs ?? entry.chatTimeoutMs ?? DEFAULT_SEND_CHAT_TIMEOUT_MS, options?.signal)
      return result as AgentChatReply
    }
    // Resolved before anything is sent, so a mistyped scenario fails loudly
    // instead of the task going out without the guidance the caller chose.
    const message = options?.scenario === undefined ? text : composeScenarioTask(findScenario(record.role, options.scenario), text)
    const reply = await this.enqueue(record, async () => {
      this.ensureOpen(record)
      const effective: SendChatOptions = {
        timeoutMs: options?.timeoutMs ?? record.chatTimeoutMs,
        signal: options?.signal,
      }
      return record.channel.sendChat(record.session, message, effective)
    })

    // 自动验证输出（如果角色定义了验证规则）。 结果附回 reply 而不是只
    // 写进 journal——调用方此前完全没有渠道知道"这次回复角色自己声明的检查有没有
    // 过"，只能盲目相信一句回复就是任务完成了。
    // The project layer may add rules of its own (project conventions a
    // generic role cannot know); they run together with the role's.
    const rules = [...record.role.verification ?? [], ...record.role.projectLayer?.verification ?? []]
    if (rules.length > 0) {
      const verification = await this.runVerification(agentId, { ...record.role, verification: rules }, reply.text)
      if (verification !== undefined) return { ...reply, verification }
    }

    return reply
  }

  /**
   * 运行输出验证
   *
   * 返回值供 {@link sendChat} 附回 `AgentChatReply.verification`；
   * 验证过程本身出错（不是"验证跑完了但没通过"，是验证器自己抛异常）时返回
   * `undefined`，调用方不应把 `undefined` 当作"通过"。
   * @internal
   */
  private async runVerification(
    agentId: string,
    role: RoleDefinition,
    output: string
  ): Promise<{ passed: boolean; results: VerificationResult[] } | undefined> {
    try {
      // 懒加载验证器
      if (!this.verifier) {
        this.verifier = new OutputVerifier()
      }

      const record = this.records.get(agentId)
      if (!record) return undefined

      // 准备验证上下文
      const context = {
        output,
        cwd: this.cwd,
        roleId: role.roleId,
      }

      this.logger?.info(`Running verification for agent ${agentId} (${role.verification!.length} rules)`)

      // 运行验证
      const results = await this.verifier.verify(context, role.verification!)

      // 统计结果
      const passed = results.filter((r: VerificationResult) => r.passed).length
      const failed = results.filter((r: VerificationResult) => !r.passed).length

      // 记录到 journal
      this.safeJournal(agentId, 'verification.completed', 'system', {
        roleId: role.roleId,
        totalRules: results.length,
        passed,
        failed,
        results: results.map((r: VerificationResult) => ({
          type: r.rule.type,
          passed: r.passed,
          message: r.message,
        })),
      })

      if (failed > 0) {
        this.logger?.warn(
          `Verification failed for agent ${agentId}: ${failed}/${results.length} rules failed`
        )
        // 记录详细失败信息
        results
          .filter((r: VerificationResult) => !r.passed)
          .forEach((r: VerificationResult) => {
            this.logger?.warn(`  - ${r.rule.type}: ${r.message}`)
          })
      } else {
        this.logger?.info(`Verification passed for agent ${agentId}: ${passed}/${results.length} rules`)
      }

      return { passed: failed === 0, results }
    } catch (error) {
      this.logger?.error(`Verification error for agent ${agentId}: ${String(error)}`)
      this.safeJournal(agentId, 'verification.error', 'system', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Close one child process and retain its journal history for inspection.
   *
   * An `agentId` this process does not own is forwarded to its owner over
   * the control socket instead of throwing immediately.
   */
  async close(agentId: string): Promise<void> {
    this.ensureLive()
    const record = this.records.get(agentId)
    if (record === undefined) {
      await this.forwardToOwner(agentId, { method: 'close', agentId }, DEFAULT_FORWARD_TIMEOUT_MS)
      return
    }
    await this.closeRecord(record)
  }

  /**
   * Read journal history using a sequence cursor and optional filters.
   *
   * Own children (live or exited) read this manager's journal. An id this
   * process never owned is looked up in the live-agent registry and, when
   * another process advertises it, read from that owner's journal instead —
   * still the journal, never a harness session file.
   */
  async readConversation(options: ReadConversationOptions): Promise<ReadConversationResult> {
    if (this.records.has(options.agentId) || this.registry === undefined) {
      return this.reader.readConversation(options)
    }
    const entry = (await this.registry.list()).find((candidate) => candidate.agentId === options.agentId)
    if (entry === undefined || entry.ownerPid === process.pid) return this.reader.readConversation(options)
    return this.externalReader(entry.journalFile).readConversation(options)
  }

  /**
   * Own children plus agents other processes advertise. Own entries in the
   * registry are skipped so a child is never listed twice; external ones are
   * reported as `open` because the registry only keeps live owners.
   */
  async discover(): Promise<DiscoveredAgent[]> {
    const own: DiscoveredAgent[] = this.list().map((agent) => ({ ...agent, external: false, ownerPid: process.pid }))
    if (this.registry === undefined) return own
    let entries: LiveAgentEntry[]
    try {
      entries = await this.registry.list()
    } catch (error) {
      this.logger?.warn(`Live-agent registry unreadable: ${String(error)}`)
      return own
    }
    const ownIds = new Set(own.map((agent) => agent.agentId))
    const external = entries
      .filter((entry) => entry.ownerPid !== process.pid && !ownIds.has(entry.agentId))
      .map((entry): DiscoveredAgent => ({
        agentId: entry.agentId,
        roleId: entry.roleId,
        ...(entry.roleVersion === undefined ? {} : { roleVersion: entry.roleVersion }),
        ...(entry.roleHash === undefined ? {} : { roleHash: entry.roleHash }),
        harness: entry.harness,
        harnessSessionId: entry.harnessSessionId,
        cwd: entry.cwd,
        keepAliveAfterTask: entry.keepAliveAfterTask,
        interactionMode: entry.interactionMode,
        showWindow: entry.showWindow,
        ...(entry.windowHandle === undefined ? {} : { windowHandle: entry.windowHandle }),
        ...(entry.childPid === undefined ? {} : { pid: entry.childPid }),
        ...(entry.evaluation === undefined ? {} : { evaluation: entry.evaluation }),
        status: 'open',
        external: true,
        ownerPid: entry.ownerPid,
      }))
    return [...own, ...external]
  }

  /** Return one diagnostic view, or `undefined` after an unknown id. */
  get(agentId: string): AgentInfo | undefined {
    const record = this.records.get(agentId)
    return record === undefined ? undefined : { ...record.handle, status: record.status }
  }

  /** Return all agents known to this manager, including exited children. */
  list(): AgentInfo[] {
    return [...this.records.values()].map((record) => ({
      ...record.handle,
      status: record.status,
      ...(record.lastTurnStartedAt === undefined ? {} : { lastTurnStartedAt: record.lastTurnStartedAt }),
      ...(record.lastTurnId === undefined ? {} : { lastTurnId: record.lastTurnId }),
    }))
  }

  /** List role definitions available for new Agent windows. */
  listRoles(): Promise<RoleSummary[]> {
    return this.roleProvider.list()
  }

  /** Stop every child and close the journal. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.records.values()]
    const results = await Promise.allSettled(records.map((record) => this.closeRecord(record)))
    // Withdrawals queued by closeRecord are fire-and-forget; a script that
    // disposes and exits must not leave ghost advertisements behind, so wait
    // for the registry to drain here (unregister is idempotent).
    if (this.registry !== undefined) {
      await Promise.allSettled(records.map((record) => this.registry!.unregister(record.handle.agentId)))
    }
    if (this.controlServer !== undefined) await this.controlServer.stop()
    await this.writer.dispose()
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'One or more child channels failed to close')
  }

  private newAgentId(): string {
    const agentId = this.idFactory()
    if (this.records.has(agentId)) throw new AgentAlreadyExistsError(agentId)
    return agentId
  }

  private onChannelEvent(agentId: string, event: { kind: JournalEvent['kind']; role: JournalEvent['role']; payload: unknown }): void {
    this.safeJournal(agentId, event.kind, event.role, event.payload)
    if (event.kind === 'agent.exited') {
      const record = this.records.get(agentId)
      if (record !== undefined && record.status !== 'closing') record.status = 'exited'
      this.withdraw(agentId)
    }
  }

  /**
   * Start this process's control endpoint on first use. Idempotent and
   * memoized — every caller awaits the same in-flight (or already-settled)
   * startup, so a burst of concurrent `spawn()` calls binds the socket once.
   */
  private ensureControlServer(): Promise<void> {
    if (this.controlServerReady === undefined) {
      this.controlServerReady = this.controlSocketPath === undefined
        ? Promise.resolve()
        : (async (): Promise<void> => {
            this.controlServer = new ControlServer({
              socketPath: this.controlSocketPath!,
              logger: this.logger,
              // An evaluation arm is driven only by its owner; requests from
              // other processes (a DSH page, another script) are refused.
              handlers: this.evaluation !== undefined
                ? {
                    sendChat: async (agentId) => { throw new AgentObserveOnlyError(agentId) },
                    sendCommand: async (agentId) => { throw new AgentObserveOnlyError(agentId) },
                    close: async (agentId) => { throw new AgentObserveOnlyError(agentId) },
                  }
                : {
                    sendChat: (agentId, text, chatOptions) => this.sendChat(agentId, text, chatOptions),
                    sendCommand: (agentId, command) => this.sendCommand(agentId, command),
                    close: (agentId) => this.close(agentId),
                  },
            })
            await this.controlServer.start()
          })()
    }
    return this.controlServerReady
  }

  /**
   * Forward a request to `agentId`'s owner over its control socket.
   * @throws {AgentNotFoundError} when no registry entry names this agent.
   * @throws {AgentOwnerUnreachableError} when nothing answers at the socket —
   *   the stale entry is pruned before this throws.
   * @throws {AgentForwardError} when the owner was reached but the exchange
   *   failed (timeout, cancellation, broken connection); the entry stays,
   *   since a slow or interrupted request says nothing about the owner.
   */
  private async forwardToOwner(agentId: string, request: ControlRequest, timeoutMs: number | ((entry: LiveAgentEntry) => number), signal?: AbortSignal): Promise<unknown> {
    if (this.registry === undefined) throw new AgentNotFoundError(agentId)
    let entries: LiveAgentEntry[]
    try {
      entries = await this.registry.list()
    } catch {
      throw new AgentNotFoundError(agentId)
    }
    const entry = entries.find((candidate) => candidate.agentId === agentId)
    // entry.ownerPid === process.pid would mean this agent is ours, which
    // callers already checked before reaching here; treated the same as
    // "unknown" rather than asserted, in case of a close-then-forward race.
    if (entry === undefined || entry.ownerPid === process.pid) throw new AgentNotFoundError(agentId)
    try {
      return await requestControl(entry.controlSocketPath, request, { timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : timeoutMs(entry), signal })
    } catch (error) {
      if (error instanceof ControlUnreachableError) {
        if (error.reason !== 'unreachable') throw new AgentForwardError(agentId, entry.ownerPid, error.message, { cause: error })
        await this.registry.unregister(agentId).catch(() => undefined)
        throw new AgentOwnerUnreachableError(agentId, entry.ownerPid, { cause: error })
      }
      throw error
    }
  }

  /** Publish a freshly opened child to other processes; failures only log. */
  private advertise(handle: AgentHandle, chatTimeoutMs: number): void {
    if (this.registry === undefined) return
    const entry: LiveAgentEntry = {
      agentId: handle.agentId,
      ownerPid: process.pid,
      ownerGeneration: this.ownerGeneration,
      controlSocketPath: this.controlSocketPath!,
      ...(handle.pid === undefined ? {} : { childPid: handle.pid }),
      roleId: handle.roleId,
      ...(handle.roleVersion === undefined ? {} : { roleVersion: handle.roleVersion }),
      ...(handle.roleHash === undefined ? {} : { roleHash: handle.roleHash }),
      harness: handle.harness,
      harnessSessionId: handle.harnessSessionId,
      cwd: handle.cwd,
      journalFile: this.journalFile,
      keepAliveAfterTask: handle.keepAliveAfterTask,
      interactionMode: handle.interactionMode,
      showWindow: handle.showWindow,
      ...(handle.windowHandle === undefined ? {} : { windowHandle: handle.windowHandle }),
      spawnedAt: Date.now(),
      chatTimeoutMs,
      ...(handle.evaluation === undefined ? {} : { evaluation: handle.evaluation }),
    }
    this.registry.register(entry).catch((error: unknown) => {
      this.logger?.warn(`Failed to advertise agent ${handle.agentId}: ${String(error)}`)
    })
  }

  private withdraw(agentId: string): void {
    this.registry?.unregister(agentId).catch((error: unknown) => {
      this.logger?.warn(`Failed to withdraw agent ${agentId}: ${String(error)}`)
    })
  }

  private externalReader(journalFile: string): JournalReader {
    let reader = this.externalReaders.get(journalFile)
    if (reader === undefined) {
      reader = new JournalReader({ file: journalFile, logger: this.logger })
      this.externalReaders.set(journalFile, reader)
    }
    return reader
  }

  private safeJournal(agentId: string, kind: JournalEvent['kind'], role: JournalEvent['role'], payload: unknown): void {
    try {
      this.writer.append(agentId, kind, role, payload)
    } catch (error) {
      this.logger?.error(`Failed to append agent journal event: ${String(error)}`)
    }
  }

  private enqueue<T>(record: AgentRecord, operation: () => Promise<T>): Promise<T> {
    const run = record.tail.then(operation, operation)
    record.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async closeRecord(record: AgentRecord): Promise<void> {
    if (record.closePromise !== undefined) return record.closePromise
    if (record.status === 'exited') return
    record.status = 'closing'
    record.closePromise = (async () => {
      try {
        await record.channel.close(record.session)
      } finally {
        record.status = 'exited'
        this.withdraw(record.handle.agentId)
      }
    })()
    return record.closePromise
  }

  private ensureOpen(record: AgentRecord): void {
    if (record.status !== 'open') throw new AgentNotFoundError(record.handle.agentId)
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('AgentManager has been disposed')
  }
}
