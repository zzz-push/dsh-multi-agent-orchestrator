/**
 * 项目策略加载器
 *
 * 从项目根目录加载安全策略配置文件。
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { McpServerLaunch } from '../channel/types.js'
import type { ProjectPolicy } from './types.js'

/**
 * 从项目根目录加载策略配置
 *
 * 查找文件优先级:
 * 1. .dsh/policy.yaml
 * 2. dsh-policy.yaml
 * 3. 默认策略（开发模式，全部允许）
 */
export async function loadProjectPolicy(
  projectRoot: string,
  options: { mcpServersFile?: string | false } = {},
): Promise<ProjectPolicy> {
  const candidates = [
    path.join(projectRoot, '.dsh/policy.yaml'),
    path.join(projectRoot, 'dsh-policy.yaml'),
  ]

  // 本机的 MCP 启动定义（路径因机器而异，不进项目仓库）；项目里的同名定义优先。
  const userServers = options.mcpServersFile === false
    ? {}
    : await loadMcpServerRegistry(options.mcpServersFile ?? defaultMcpServersFile())

  for (const file of candidates) {
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch {
      // 文件不存在，继续尝试下一个
      continue
    }
    const policy = parseYaml(content) as ProjectPolicy
    const normalized = normalizePolicy(policy)
    const mcpServers = { ...userServers, ...parseMcpServers(policy.mcpServers, file) }
    return Object.keys(mcpServers).length === 0 ? normalized : { ...normalized, mcpServers }
  }

  // 未找到策略文件，返回开发模式默认策略
  const fallback = getDefaultDevelopmentPolicy()
  return Object.keys(userServers).length === 0 ? fallback : { ...fallback, mcpServers: userServers }
}

/** `~/.dsh/mcp-servers.yaml` — this machine's MCP server launch definitions. */
export function defaultMcpServersFile(): string {
  return path.join(os.homedir(), '.dsh', 'mcp-servers.yaml')
}

/**
 * Read a machine-level MCP registry: a YAML mapping of server name →
 * `{ command, args?, env? }`, optionally under a top-level `mcpServers` key.
 * A missing file is an empty registry.
 */
export async function loadMcpServerRegistry(file: string): Promise<Record<string, McpServerLaunch>> {
  let content: string
  try {
    content = await readFile(file, 'utf-8')
  } catch {
    return {}
  }
  const raw = parseYaml(content) as Record<string, unknown> | null
  const servers = raw !== null && typeof raw === 'object' && 'mcpServers' in raw ? raw.mcpServers : raw
  return parseMcpServers(servers, file)
}

/** Validate launch definitions; a malformed entry is an error, not silently dropped. */
export function parseMcpServers(value: unknown, source: string): Record<string, McpServerLaunch> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: mcpServers must be a mapping of name → { command, args?, env? }`)
  const servers: Record<string, McpServerLaunch> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const launch = entry as Record<string, unknown> | null
    if (launch === null || typeof launch !== 'object' || typeof launch.command !== 'string' || launch.command === '') {
      throw new Error(`${source}: mcpServers.${name}.command must be a non-empty string`)
    }
    if (launch.args !== undefined && (!Array.isArray(launch.args) || !launch.args.every((arg) => typeof arg === 'string'))) {
      throw new Error(`${source}: mcpServers.${name}.args must be a list of strings`)
    }
    if (launch.env !== undefined && (typeof launch.env !== 'object' || launch.env === null || !Object.values(launch.env).every((v) => typeof v === 'string'))) {
      throw new Error(`${source}: mcpServers.${name}.env must be a mapping of strings`)
    }
    servers[name] = {
      command: launch.command,
      ...(launch.args === undefined ? {} : { args: launch.args as string[] }),
      ...(launch.env === undefined ? {} : { env: launch.env as Record<string, string> }),
    }
  }
  return servers
}

/** Replace `${projectRoot}` / `${agentCwd}` in a launch definition. */
export function expandMcpServerLaunch(launch: McpServerLaunch, values: { projectRoot: string; agentCwd: string }): McpServerLaunch {
  const expand = (text: string): string => text.replaceAll('${projectRoot}', values.projectRoot).replaceAll('${agentCwd}', values.agentCwd)
  return {
    command: expand(launch.command),
    ...(launch.args === undefined ? {} : { args: launch.args.map(expand) }),
    ...(launch.env === undefined ? {} : { env: Object.fromEntries(Object.entries(launch.env).map(([key, val]) => [key, expand(val)])) }),
  }
}

/**
 * 规范化策略配置
 */
function normalizePolicy(policy: ProjectPolicy): ProjectPolicy {
  return {
    allowedHarnesses: policy.allowedHarnesses,
    allowedMcpServers: policy.allowedMcpServers,
    allowedFileOperations: policy.allowedFileOperations,
    allowedShellPatterns: policy.allowedShellPatterns,
    allowedSandboxModes: policy.allowedSandboxModes,
    defaults: {
      harness: policy.defaults?.harness,
      // Only what the project wrote: filling a default here would
      // override every role that relies on its own normalized timeout.
      chatTimeoutMs: policy.defaults?.chatTimeoutMs,
      interactionMode: policy.defaults?.interactionMode ?? 'headless',
    },
  }
}

/**
 * 开发模式默认策略（全部允许）
 */
export function getDefaultDevelopmentPolicy(): ProjectPolicy {
  return {
    // undefined = 全部允许
    allowedHarnesses: undefined,
    allowedMcpServers: undefined,
    allowedFileOperations: undefined,
    allowedShellPatterns: undefined,
    allowedSandboxModes: undefined,
    defaults: {
      interactionMode: 'headless',
    },
  }
}

/**
 * 生产模式严格策略示例
 */
export function getStrictProductionPolicy(): ProjectPolicy {
  return {
    allowedHarnesses: ['codex', 'claude-code'],
    allowedMcpServers: ['example-mcp'], // 只允许已审核的 MCP 服务器
    allowedFileOperations: ['read', 'list'], // 禁止写入和删除
    allowedShellPatterns: ['^example-mcp ', '^git status$'], // 只允许特定命令
    allowedSandboxModes: ['read-only'], // 只读；两个 harness 都认这个名字
    defaults: {
      harness: 'codex',
      chatTimeoutMs: 300000,
      interactionMode: 'headless',
    },
  }
}
