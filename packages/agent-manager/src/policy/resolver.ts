/**
 * PolicyResolver - 策略解析器
 *
 * 将角色的权限请求与项目策略进行交集验证，
 * 返回最终允许的权限集合。
 *
 * 确保角色 YAML 不能自授权。
 */

import type { McpServerLaunch } from '../channel/types.js'
import type { RoleExecution } from '../role/types.js'
import type {
  ProjectPolicy,
  ResolvedPermissions,
  PolicyViolation,
} from './types.js'
import { PolicyError } from './types.js'

export class PolicyResolver {
  constructor(private readonly projectPolicy: ProjectPolicy) {}

  /**
   * 解析角色权限请求
   *
   * @param roleExecution 角色声明的执行配置
   * @param roleId 角色 ID（用于日志）
   * @param declared 角色文件里真正写了的值。`roleExecution` 是加载器
   *   规范化之后的结果，没写的超时已经被填成缺省值，单看它分不清"写了 10 分钟"和
   *   "没写"；传了这个参数，没写的超时就让位给项目策略的 `defaults.chatTimeoutMs`。
   *   不传时按旧语义把 `roleExecution.chatTimeoutMs` 当作角色声明。
   * @returns 解析后的权限
   */
  resolve(roleExecution: RoleExecution, roleId: string, declared?: { chatTimeoutMs?: number }): ResolvedPermissions {
    const violations: PolicyViolation[] = []
    const refused: PolicyViolation[] = []

    // 1. 验证 harness
    const harness = this.resolveHarness(roleExecution.harness, violations, refused)

    // 2. 验证工具请求
    const toolRequest = this.resolveToolRequest(roleExecution.tools, violations)

    // 2b. 第三方工具：只有角色声明过、项目允许、并且有启动定义的 MCP 服务器
    const mcpServers = this.resolveMcpServers(toolRequest?.mcpServers ?? [], violations)

    // 3. 验证沙箱模式
    const sandbox = this.resolveSandbox(roleExecution.sandbox, violations, refused)

    // 4. 设置执行参数（使用角色声明或默认值）
    const execution = {
      chatTimeoutMs:
        (declared === undefined ? roleExecution.chatTimeoutMs : declared.chatTimeoutMs) ??
        this.projectPolicy.defaults?.chatTimeoutMs ??
        roleExecution.chatTimeoutMs ??
        600000,
      interactionMode:
        roleExecution.interactionMode ??
        this.projectPolicy.defaults?.interactionMode ??
        'headless',
      keepAliveAfterTask: roleExecution.keepAliveAfterTask,
    }

    // 5. 判断是否允许
    const allowed = violations.length === 0

    return {
      allowed,
      harness,
      toolRequest,
      mcpServers,
      sandbox,
      execution,
      violations: violations.length > 0 ? violations : undefined,
      ...(refused.length > 0 ? { refused } : {}),
    }
  }

  /**
   * 验证并抛出错误（用于严格模式）
   */
  resolveOrThrow(
    roleExecution: RoleExecution,
    roleId: string
  ): ResolvedPermissions {
    const result = this.resolve(roleExecution, roleId)
    if (!result.allowed) {
      throw new PolicyError(
        `Role "${roleId}" has ${result.violations!.length} policy violation(s)`,
        result.violations!
      )
    }
    return result
  }

  /**
   * 解析 harness 请求
   */
  private resolveHarness(
    requested: string,
    violations: PolicyViolation[],
    refused: PolicyViolation[]
  ): string {
    const allowed = this.projectPolicy.allowedHarnesses

    // undefined = 全部允许（开发模式）
    if (allowed === undefined) {
      return requested
    }

    // 空数组 = 全部禁止：没有可以降级到的 harness，这个 agent 不能启动
    if (allowed.length === 0) {
      const violation = {
        type: 'harness' as const,
        requested,
        reason: 'Project policy prohibits all harnesses',
      }
      violations.push(violation)
      refused.push(violation)
      return 'none'
    }

    // 检查是否在允许列表中
    if (!allowed.includes(requested)) {
      violations.push({
        type: 'harness',
        requested,
        reason: `Harness "${requested}" not in allowed list: [${allowed.join(', ')}]`,
      })
      // 降级到默认值——前提是它本身在允许列表里——否则第一个允许的
      const fallback = this.projectPolicy.defaults?.harness
      return fallback !== undefined && allowed.includes(fallback) ? fallback : allowed[0]!
    }

    return requested
  }

  /**
   * 解析工具请求
   */
  private resolveToolRequest(
    requested: unknown,
    violations: PolicyViolation[]
  ): { mcpServers?: string[]; fileOperations?: string[]; shellCommands?: string[] } | undefined {
    if (!requested || typeof requested !== 'object') {
      return undefined
    }

    const req = requested as Record<string, unknown>
    const result: ResolvedPermissions['toolRequest'] = {}

    // 验证 MCP 服务器
    if (req.mcp_servers || req.mcpServers) {
      const mcpServers = (req.mcp_servers || req.mcpServers) as string[]
      result.mcpServers = this.filterByAllowList(
        mcpServers,
        this.projectPolicy.allowedMcpServers,
        'mcp_server',
        violations
      )
    }

    // 验证文件操作
    if (req.file_operations || req.fileOperations) {
      const fileOps = (req.file_operations || req.fileOperations) as string[]
      result.fileOperations = this.filterByAllowList(
        fileOps,
        this.projectPolicy.allowedFileOperations,
        'file_operation',
        violations
      )
    }

    // 验证 shell 命令
    if (req.shell_commands || req.shellCommands) {
      const shellCmds = (req.shell_commands || req.shellCommands) as string[]
      result.shellCommands = this.filterShellCommands(shellCmds, violations)
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  /**
   * 把已经通过允许列表的服务器名换成启动定义。名字允许了但没有启动定义，
   * 同样记一条违规：角色以为自己有这个工具，实际拿不到，调用方应当看得见。
   */
  private resolveMcpServers(
    names: string[],
    violations: PolicyViolation[]
  ): Record<string, McpServerLaunch> {
    const resolved: Record<string, McpServerLaunch> = {}
    for (const name of names) {
      const launch = this.projectPolicy.mcpServers?.[name]
      if (launch === undefined) {
        violations.push({
          type: 'mcp_server',
          requested: name,
          reason: `MCP server "${name}" has no launch definition (add it to .dsh/policy.yaml mcpServers or ~/.dsh/mcp-servers.yaml)`,
        })
        continue
      }
      resolved[name] = launch
    }
    return resolved
  }

  /**
   * 解析沙箱模式
   */
  private resolveSandbox(
    requested: unknown,
    violations: PolicyViolation[],
    refused: PolicyViolation[]
  ): string | undefined {
    const allowed = this.projectPolicy.allowedSandboxModes

    // 角色没声明沙箱：有允许列表时用第一个允许的模式，而不是交给 harness 自己的
    // 默认值——那来自本机配置（~/.claude/settings.json、codex 的 config.toml），
    // 可能比策略允许的任何模式都宽。没有允许列表时保持不设。
    if (!requested) {
      if (allowed === undefined) return undefined
      if (allowed.length === 0) {
        const violation = {
          type: 'sandbox' as const,
          requested: '(none declared)',
          reason: 'Project policy prohibits all sandbox modes',
        }
        violations.push(violation)
        refused.push(violation)
        return undefined
      }
      return allowed[0]
    }

    const mode = String(requested)

    if (allowed === undefined) {
      return mode
    }

    if (!allowed.includes(mode)) {
      const violation = {
        type: 'sandbox' as const,
        requested: mode,
        reason: allowed.length === 0
          ? 'Project policy prohibits all sandbox modes'
          : `Sandbox mode "${mode}" not in allowed list: [${allowed.join(', ')}]`,
      }
      violations.push(violation)
      // 降级到第一个允许的模式；一个都不允许时不能启动
      if (allowed.length === 0) refused.push(violation)
      return allowed[0]
    }

    return mode
  }

  /**
   * 按允许列表过滤
   */
  private filterByAllowList(
    requested: string[],
    allowed: string[] | undefined,
    type: PolicyViolation['type'],
    violations: PolicyViolation[]
  ): string[] {
    if (allowed === undefined) {
      return requested // 全部允许
    }

    if (allowed.length === 0) {
      // 全部禁止
      requested.forEach((item) => {
        violations.push({
          type,
          requested: item,
          reason: `Project policy prohibits all ${type}s`,
        })
      })
      return []
    }

    // 过滤出允许的项
    const result: string[] = []
    requested.forEach((item) => {
      if (allowed.includes(item)) {
        result.push(item)
      } else {
        violations.push({
          type,
          requested: item,
          reason: `${type} "${item}" not in allowed list: [${allowed.join(', ')}]`,
        })
      }
    })

    return result
  }

  /**
   * 验证 shell 命令（基于正则模式）
   */
  private filterShellCommands(
    requested: string[],
    violations: PolicyViolation[]
  ): string[] {
    const patterns = this.projectPolicy.allowedShellPatterns

    if (patterns === undefined) {
      // undefined = 禁止所有 shell 命令
      requested.forEach((cmd) => {
        violations.push({
          type: 'shell_command',
          requested: cmd,
          reason: 'Project policy prohibits shell commands',
        })
      })
      return []
    }

    // 检查每个命令是否匹配允许的模式
    const result: string[] = []
    requested.forEach((cmd) => {
      const matched = patterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(cmd)
        } catch {
          return false
        }
      })

      if (matched) {
        result.push(cmd)
      } else {
        violations.push({
          type: 'shell_command',
          requested: cmd,
          reason: `Command does not match any allowed pattern: [${patterns.join(', ')}]`,
        })
      }
    })

    return result
  }
}
