import type { McpServerLaunch } from '../channel/types.js'

/**
 * PolicyResolver 权限验证类型定义
 *
 * 本模块定义项目级安全策略和权限解析相关的类型。
 * 确保角色 YAML 不能自授权。
 */

/**
 * 项目级安全策略
 *
 * 定义项目允许的 harness、工具和沙箱模式。
 * 角色请求必须是这些允许项的子集。
 */
export interface ProjectPolicy {
  /**
   * 允许的 harness 列表
   * - undefined: 全部允许（仅开发环境）
   * - []: 全部禁止
   * - ['codex', 'claude-code']: 白名单
   */
  allowedHarnesses?: string[]

  /**
   * 允许的 MCP 服务器列表
   */
  allowedMcpServers?: string[]

  /**
   * MCP 服务器的启动定义（名字 → 命令）。角色只声明要用哪些服务器的名字；
   * 怎么启动由这里决定——启动一个程序是项目/本机的决定，不能由角色文件
   * 自己授权。本机专属的路径放在用户级文件
   * `~/.dsh/mcp-servers.yaml`，加载时合并进来，项目里的同名定义优先。
   * 命令、参数、环境变量里可以写 `${projectRoot}`（AgentManager 的 cwd）和
   * `${agentCwd}`（这个 agent 的工作目录）。
   */
  mcpServers?: Record<string, McpServerLaunch>

  /**
   * 允许的文件操作
   */
  allowedFileOperations?: string[]

  /**
   * 允许的 shell 命令模式（正则表达式）
   * undefined = 全部禁止
   */
  allowedShellPatterns?: string[]

  /**
   * 允许的沙箱模式
   */
  allowedSandboxModes?: string[]

  /**
   * 默认策略（当角色未声明时）
   */
  defaults?: {
    harness?: string
    chatTimeoutMs?: number
    interactionMode?: 'headless' | 'interactive'
  }
}

/**
 * 权限解析结果
 */
export interface ResolvedPermissions {
  /**
   * 是否通过验证
   */
  allowed: boolean

  /**
   * 解析后的 harness（可能被策略覆盖）
   */
  harness: string

  /**
   * 解析后的工具请求
   */
  toolRequest?: {
    mcpServers?: string[]
    fileOperations?: string[]
    shellCommands?: string[]
  }

  /**
   * 这个 agent 实际拿到的第三方工具：角色声明 ∩ 项目允许 ∩ 有启动定义。
   * 总是有值（可能为空）；通道只提供这些，其余一概不给。
   */
  mcpServers: Record<string, McpServerLaunch>

  /**
   * 解析后的沙箱模式
   */
  sandbox?: string

  /**
   * 策略在某一类上没有任何可以授予的值（允许列表为空）而角色又需要它：这样的
   * agent 不能启动。降级只在还有允许的值可选时发生；无可降级时回落到角色自己
   * 的请求，等于让策略失效。
   */
  refused?: PolicyViolation[]

  /**
   * 执行参数（超时、交互模式等）
   */
  execution: {
    chatTimeoutMs: number
    interactionMode: 'headless' | 'interactive'
    keepAliveAfterTask: boolean
  }

  /**
   * 被拒绝的请求（如果 allowed = false）
   */
  violations?: PolicyViolation[]
}

/**
 * 策略违反记录
 */
export interface PolicyViolation {
  /**
   * 违反类型
   */
  type: 'harness' | 'mcp_server' | 'file_operation' | 'shell_command' | 'sandbox'

  /**
   * 被拒绝的值
   */
  requested: string

  /**
   * 原因
   */
  reason: string
}

/**
 * 策略解析错误
 */
export class PolicyError extends Error {
  constructor(
    message: string,
    public readonly violations: PolicyViolation[]
  ) {
    super(message)
    this.name = 'PolicyError'
  }
}
