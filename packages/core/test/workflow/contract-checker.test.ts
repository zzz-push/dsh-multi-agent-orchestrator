import { describe, expect, it } from 'vitest'
import { ContractChecker } from '../../src/workflow/contract-checker.js'
import type { WorkflowStepDef } from '../../src/workflow/types.js'
import type { RoleDefinition } from '@dsh/spec'

const checker = new ContractChecker()

function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    roleId: 'role',
    name: 'Role',
    version: '1.0.0',
    description: 'test role',
    systemPrompt: 'test',
    capabilities: [],
    execution: {
      harness: 'codex',
      keepAliveAfterTask: false,
      chatTimeoutMs: 600_000,
    },
    raw: {},
    ...overrides,
  }
}

describe('ContractChecker', () => {
  describe('checkStepPair', () => {
    it('passes when the upstream schema provides every required field', () => {
      const upstream = role({
        roleId: 'architect',
        contract: {
          output: {
            schema: {
              type: 'object',
              properties: {
                architecture: { type: 'string' },
                interfaces: { type: 'array' },
              },
            },
          },
        },
      })
      const downstream = role({
        roleId: 'implementer',
        contract: { input: { required: ['architecture', 'interfaces'] } },
      })

      expect(checker.checkStepPair(upstream, downstream)).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      })
    })

    it('reports every field not supplied by the upstream schema', () => {
      const upstream = role({
        roleId: 'analyzer',
        contract: { output: { schema: { properties: { summary: { type: 'string' } } } } },
      })
      const downstream = role({
        roleId: 'implementer',
        contract: { input: { required: ['architecture', 'interfaces'] } },
      })

      const result = checker.checkStepPair(upstream, downstream)

      expect(result.valid).toBe(false)
      expect(result.errors.map((error) => error.field)).toEqual(['architecture', 'interfaces'])
      expect(result.errors[0]).toMatchObject({ stepId: 'implementer', upstreamStepId: 'analyzer' })
    })

    it('passes when the downstream has no required input', () => {
      expect(checker.checkStepPair(role(), role())).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      })
    })

    it('uses collaboration handoff declarations as supplied fields', () => {
      const upstream = role({
        roleId: 'architect',
        collaboration: {
          handoff: {
            provides: [{ name: 'interface_definitions', source: 'output.interfaces' }],
          },
        },
      })
      const downstream = role({
        roleId: 'implementer',
        contract: { input: { required: ['interface_definitions'] } },
      })

      expect(checker.checkStepPair(upstream, downstream)).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      })
    })

    it('warns but does not reject an upstream with no output declaration', () => {
      const result = checker.checkStepPair(
        role({ roleId: 'upstream' }),
        role({ roleId: 'downstream', contract: { input: { required: ['input'] } } }),
      )

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toMatchObject({ stepId: 'downstream' })
    })
  })

  describe('checkWorkflow', () => {
    it('accepts a compatible workflow', () => {
      const steps: WorkflowStepDef[] = [
        { id: 'design', roleId: 'architect', dependsOn: [] },
        { id: 'implement', roleId: 'implementer', dependsOn: ['design'] },
        { id: 'verify', roleId: 'tester', dependsOn: ['implement'] },
      ]
      const roles = new Map<string, RoleDefinition>([
        ['design', role({ contract: { output: { schema: { properties: { architecture: {} } } } } })],
        [
          'implement',
          role({
            contract: {
              input: { required: ['architecture'] },
              output: { schema: { properties: { code: {} } } },
            },
          }),
        ],
        ['verify', role({ contract: { input: { required: ['code'] } } })],
      ])

      expect(checker.checkWorkflow(steps, roles)).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      })
    })

    it('reports fields not supplied by any dependency', () => {
      const steps: WorkflowStepDef[] = [
        { id: 'analyze', roleId: 'analyzer', dependsOn: [] },
        { id: 'implement', roleId: 'implementer', dependsOn: ['analyze'] },
      ]
      const roles = new Map<string, RoleDefinition>([
        ['analyze', role({ contract: { output: { schema: { properties: { summary: {} } } } } })],
        ['implement', role({ contract: { input: { required: ['architecture', 'interfaces'] } } })],
      ])

      const result = checker.checkWorkflow(steps, roles)

      expect(result.valid).toBe(false)
      expect(result.errors.map((error) => error.field)).toEqual(['architecture', 'interfaces'])
    })

    it('accepts a field supplied by any one direct dependency', () => {
      const steps: WorkflowStepDef[] = [
        { id: 'research', roleId: 'researcher', dependsOn: [] },
        { id: 'design', roleId: 'architect', dependsOn: [] },
        { id: 'implement', roleId: 'implementer', dependsOn: ['research', 'design'] },
      ]
      const roles = new Map<string, RoleDefinition>([
        ['research', role({ contract: { output: { schema: { properties: { findings: {} } } } } })],
        ['design', role({ collaboration: { handoff: { provides: [{ name: 'architecture', source: 'output.architecture' }] } } })],
        ['implement', role({ contract: { input: { required: ['architecture'] } } })],
      ])

      expect(checker.checkWorkflow(steps, roles).valid).toBe(true)
    })

    it('reports an absent role definition', () => {
      const result = checker.checkWorkflow(
        [{ id: 'missing', roleId: 'unknown-role', dependsOn: [] }],
        new Map(),
      )

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual([
        {
          stepId: 'missing',
          field: 'role',
          message: '找不到角色定义: unknown-role',
        },
      ])
    })

    it('warns when a root step requires input', () => {
      const result = checker.checkWorkflow(
        [{ id: 'root', roleId: 'root-role', dependsOn: [] }],
        new Map([['root', role({ contract: { input: { required: ['project_context'] } } })]]),
      )

      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.warnings).toEqual([
        {
          stepId: 'root',
          message: '步骤需要输入 project_context，但没有声明依赖',
        },
      ])
    })
  })

  describe('formatReport', () => {
    it('renders success reports', () => {
      const report = checker.formatReport({ valid: true, errors: [], warnings: [] })

      expect(report).toContain('✅')
      expect(report).toContain('通过')
    })

    it('renders errors and warnings with their step identifiers', () => {
      const report = checker.formatReport({
        valid: false,
        errors: [{ stepId: 'implement', upstreamStepId: 'design', field: 'architecture', message: '缺少必需字段' }],
        warnings: [{ stepId: 'verify', message: '上游输出未声明' }],
      })

      expect(report).toContain('❌')
      expect(report).toContain('implement')
      expect(report).toContain('design')
      expect(report).toContain('architecture')
      expect(report).toContain('verify')
    })
  })
})
