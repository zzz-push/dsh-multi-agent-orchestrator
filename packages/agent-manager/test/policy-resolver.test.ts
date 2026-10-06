import { describe, it, expect } from 'vitest'
import { PolicyResolver } from '../src/policy/resolver.js'
import { PolicyError } from '../src/policy/types.js'
import type { ProjectPolicy } from '../src/policy/types.js'
import type { RoleExecution } from '../src/role/types.js'

describe('PolicyResolver', () => {
  describe('harness 验证', () => {
    it('应该允许在白名单中的 harness', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: ['codex', 'claude-code'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(true)
      expect(result.harness).toBe('codex')
      expect(result.violations).toBeUndefined()
    })

    it('应该拒绝不在白名单中的 harness', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: ['codex'],
        defaults: { harness: 'codex' },
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'unknown-harness',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.harness).toBe('codex') // 降级到默认值
      expect(result.violations).toHaveLength(1)
      expect(result.violations![0].type).toBe('harness')
      expect(result.violations![0].requested).toBe('unknown-harness')
    })

    it('开发模式应该允许任何 harness', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: undefined, // undefined = 全部允许
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'any-harness',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(true)
      expect(result.harness).toBe('any-harness')
    })

    it('空数组应该禁止所有 harness', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: [],
        defaults: { harness: 'fallback' },
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      // Not even defaults.harness: an empty list allows nothing to fall back to.
      expect(result.harness).toBe('none')
      expect(result.violations).toHaveLength(1)
      expect(result.refused).toEqual(result.violations)
    })

    it('不在允许列表里的 defaults.harness 不能作为降级目标', () => {
      const resolver = new PolicyResolver({
        allowedHarnesses: ['claude-code'],
        defaults: { harness: 'codex' },
      })

      const result = resolver.resolve({
        harness: 'other',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }, 'test-role')

      expect(result.harness).toBe('claude-code')
      expect(result.refused).toBeUndefined()
    })
  })

  describe('MCP 服务器验证', () => {
    it('应该过滤出允许的 MCP 服务器', () => {
      const policy: ProjectPolicy = {
        allowedMcpServers: ['example-mcp', 'filesystem'],
        // Launch definitions exist, so only the allow list is under test here.
        mcpServers: { 'example-mcp': { command: 'example-mcp-mcp' }, filesystem: { command: 'fs-mcp' } },
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          mcp_servers: ['example-mcp', 'dangerous-server', 'filesystem'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false) // 有违规
      expect(result.toolRequest?.mcpServers).toEqual(['example-mcp', 'filesystem'])
      expect(result.violations).toHaveLength(1)
      expect(result.violations![0].requested).toBe('dangerous-server')
      expect(result.violations![0].type).toBe('mcp_server')
    })

    it('undefined 应该允许所有 MCP 服务器', () => {
      const policy: ProjectPolicy = {
        allowedMcpServers: undefined,
        mcpServers: { 'any-server': { command: 'any-mcp' } },
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          mcp_servers: ['any-server'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(true)
      expect(result.toolRequest?.mcpServers).toEqual(['any-server'])
    })

    it('空数组应该禁止所有 MCP 服务器', () => {
      const policy: ProjectPolicy = {
        allowedMcpServers: [],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          mcp_servers: ['example-mcp'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.toolRequest?.mcpServers).toEqual([])
      expect(result.violations).toHaveLength(1)
    })
  })

  describe('文件操作验证', () => {
    it('应该过滤文件操作', () => {
      const policy: ProjectPolicy = {
        allowedFileOperations: ['read', 'list'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          file_operations: ['read', 'write', 'delete'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.toolRequest?.fileOperations).toEqual(['read'])
      expect(result.violations).toHaveLength(2) // write, delete
    })
  })

  describe('Shell 命令验证', () => {
    it('应该验证 shell 命令匹配允许的模式', () => {
      const policy: ProjectPolicy = {
        allowedShellPatterns: ['^example-mcp ', '^git status$'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          shell_commands: ['example-mcp list', 'git status', 'rm -rf /'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.toolRequest?.shellCommands).toEqual(['example-mcp list', 'git status'])
      expect(result.violations).toHaveLength(1)
      expect(result.violations![0].requested).toBe('rm -rf /')
    })

    it('undefined 应该禁止所有 shell 命令', () => {
      const policy: ProjectPolicy = {
        allowedShellPatterns: undefined, // 禁止全部
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          shell_commands: ['ls'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.toolRequest?.shellCommands).toEqual([])
    })

    it('应该处理无效的正则表达式', () => {
      const policy: ProjectPolicy = {
        allowedShellPatterns: ['[invalid('],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          shell_commands: ['any-command'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.toolRequest?.shellCommands).toEqual([])
    })
  })

  describe('沙箱模式验证', () => {
    it('应该验证沙箱模式', () => {
      const policy: ProjectPolicy = {
        allowedSandboxModes: ['read-only', 'workspace-write'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        sandbox: 'danger-full-access',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.sandbox).toBe('read-only') // 降级到第一个允许的
      expect(result.violations).toHaveLength(1)
      expect(result.violations![0].type).toBe('sandbox')
    })

    it('角色没声明沙箱时用第一个允许的模式，不交给 harness 的默认值', () => {
      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const listed = new PolicyResolver({ allowedSandboxModes: ['read-only', 'workspace-write'] }).resolve(execution, 'test-role')
      expect(listed.sandbox).toBe('read-only')
      expect(listed.allowed).toBe(true)

      // Without an allow list nothing is chosen for the role.
      expect(new PolicyResolver({}).resolve(execution, 'test-role').sandbox).toBeUndefined()

      const prohibited = new PolicyResolver({ allowedSandboxModes: [] }).resolve(execution, 'test-role')
      expect(prohibited.sandbox).toBeUndefined()
      expect(prohibited.refused).toHaveLength(1)
    })

    it('空数组禁止所有沙箱模式：没有可降级的模式，拒绝而不是放行角色的请求', () => {
      const resolver = new PolicyResolver({ allowedSandboxModes: [] })

      const result = resolver.resolve({
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        sandbox: 'danger-full-access',
      }, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.sandbox).toBeUndefined()
      expect(result.refused).toHaveLength(1)
      expect(result.refused![0]!.type).toBe('sandbox')
    })
  })

  describe('执行参数', () => {
    it('应该使用角色声明的执行参数', () => {
      const policy: ProjectPolicy = {}
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: false,
        chatTimeoutMs: 300000,
        interactionMode: 'interactive',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.execution.chatTimeoutMs).toBe(300000)
      expect(result.execution.interactionMode).toBe('interactive')
      expect(result.execution.keepAliveAfterTask).toBe(false)
    })

    it('应该使用默认值当角色未声明时', () => {
      const policy: ProjectPolicy = {
        defaults: {
          chatTimeoutMs: 120000,
          interactionMode: 'headless',
        },
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.execution.chatTimeoutMs).toBe(600000) // 角色值优先
    })

    it('区分"角色写了"和"加载器填的缺省"：没写的让位给项目默认', () => {
      const execution: RoleExecution = { harness: 'codex', keepAliveAfterTask: true, chatTimeoutMs: 600000 }
      const withDefault = new PolicyResolver({ defaults: { chatTimeoutMs: 1800000 } })
      expect(withDefault.resolve(execution, 'r', { chatTimeoutMs: undefined }).execution.chatTimeoutMs).toBe(1800000)
      expect(withDefault.resolve(execution, 'r', { chatTimeoutMs: 900000 }).execution.chatTimeoutMs).toBe(900000)
      // No project default: the role's normalized value, not a second hard-coded one.
      const without = new PolicyResolver({})
      expect(without.resolve({ ...execution, chatTimeoutMs: 123 }, 'r', { chatTimeoutMs: undefined }).execution.chatTimeoutMs).toBe(123)
    })
  })

  describe('resolveOrThrow', () => {
    it('有违规时应该抛出 PolicyError', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: ['codex'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'banned-harness',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      expect(() => {
        resolver.resolveOrThrow(execution, 'test-role')
      }).toThrow(PolicyError)

      try {
        resolver.resolveOrThrow(execution, 'test-role')
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyError)
        expect((error as PolicyError).violations).toHaveLength(1)
      }
    })

    it('无违规时应该正常返回', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: ['codex'],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'codex',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
      }

      const result = resolver.resolveOrThrow(execution, 'test-role')

      expect(result.allowed).toBe(true)
      expect(result.harness).toBe('codex')
    })
  })

  describe('复合场景', () => {
    it('应该处理多种违规', () => {
      const policy: ProjectPolicy = {
        allowedHarnesses: ['codex'],
        allowedMcpServers: ['example-mcp'],
        allowedShellPatterns: ['^git '],
      }
      const resolver = new PolicyResolver(policy)

      const execution: RoleExecution = {
        harness: 'banned',
        keepAliveAfterTask: true,
        chatTimeoutMs: 600000,
        interactionMode: 'headless',
        tools: {
          mcp_servers: ['bad-server'],
          shell_commands: ['rm -rf /'],
        },
      }

      const result = resolver.resolve(execution, 'test-role')

      expect(result.allowed).toBe(false)
      expect(result.violations).toHaveLength(3) // harness + mcp + shell
    })
  })
})
