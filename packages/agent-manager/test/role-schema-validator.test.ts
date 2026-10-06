import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRoleProvider } from '../src/role/file-provider.js'
import { RoleSchemaError, validateRoleDocument } from '../src/role/schema-validator.js'

const validDocument = () => ({
  api_version: 'dsh.orchestrator/v1alpha1',
  kind: 'Role',
  metadata: {
    role_id: 'test-role',
    name: 'Test Role',
    version: '1.0.0',
    description: 'A test role',
    annotations: { 'dsh.when_to_use': 'For tests' },
  },
  system_prompt: 'You are a test agent',
  capabilities: ['testing'],
  execution: {
    harness: 'codex',
    keep_alive_after_task: false,
  },
})

describe('RoleSchemaValidator', () => {
  it('accepts and normalizes a valid versioned role document', () => {
    const result = validateRoleDocument(validDocument(), 'test.yaml')

    expect(result).toMatchObject({
      roleId: 'test-role',
      name: 'Test Role',
      version: '1.0.0',
      annotations: { 'dsh.when_to_use': 'For tests' },
      execution: { harness: 'codex', keepAliveAfterTask: false, chatTimeoutMs: 600_000 },
    })
  })

  it('rejects an unsupported API version', () => {
    const document = validDocument()
    document.api_version = 'dsh.orchestrator/v2'
    expect(() => validateRoleDocument(document, 'test.yaml')).toThrow(/不支持的 API 版本/)
  })

  it('rejects an invalid kind', () => {
    const document = validDocument()
    document.kind = 'Workflow'
    expect(() => validateRoleDocument(document, 'test.yaml')).toThrow(/期望 kind: Role/)
  })

  it('reports the source path and missing metadata field', () => {
    const document = validDocument()
    delete (document.metadata as Partial<typeof document.metadata>).name

    expect(() => validateRoleDocument(document, '/roles/test.yaml'))
      .toThrow('/roles/test.yaml: metadata.name 必须是非空字符串')
  })

  it('requires a semver metadata version', () => {
    const document = validDocument()
    document.metadata.version = '1.0'
    expect(() => validateRoleDocument(document, 'test.yaml')).toThrow(/metadata.version 必须是 semver/)
  })

  it('rejects a missing new-format lifecycle setting', () => {
    const document = validDocument()
    delete (document.execution as Partial<typeof document.execution>).keep_alive_after_task
    expect(() => validateRoleDocument(document, 'test.yaml'))
      .toThrow(/execution.keep_alive_after_task 必须是布尔值/)
  })

  it('normalizes execution and retains optional declarations', () => {
    const document = validDocument()
    Object.assign(document.execution, {
      interaction_mode: 'interactive',
      show_window: true,
      chat_timeout_ms: 120_000,
      tool_request: { requested: ['read'] },
      sandbox: 'workspace-readonly',
    })

    const result = validateRoleDocument(document, 'test.yaml')
    expect(result.execution).toMatchObject({
      interactionMode: 'interactive',
      showWindow: true,
      chatTimeoutMs: 120_000,
      tools: { requested: ['read'] },
      sandbox: 'workspace-readonly',
    })
  })

  it('stores contract, verification, and collaboration without deep validation', () => {
    const document = {
      ...validDocument(),
      contract: { input: { required: ['task_description'] } },
      verification: [{ type: 'output_structure', config: { format: 'markdown' } }],
      collaboration: { typical_downstream: ['example-builder'] },
    }

    const result = validateRoleDocument(document, 'test.yaml')
    expect(result.contract?.input?.required).toEqual(['task_description'])
    expect(result.verification).toEqual(document.verification)
    expect(result.collaboration).toEqual(document.collaboration)
  })

  it('adapts legacy documents while preserving their historic defaults', () => {
    const result = validateRoleDocument({
      role_id: 'old-role',
      name: 'Old Role',
      execution: { harness: 'codex', keep_alive_after_task: true },
    }, 'old.yaml')

    expect(result).toMatchObject({
      roleId: 'old-role',
      version: '0.0.0',
      description: '',
      systemPrompt: '',
      capabilities: [],
      execution: { harness: 'codex', keepAliveAfterTask: true, chatTimeoutMs: 600_000 },
    })
  })

  it('preserves explicitly empty legacy description and system prompt fields', () => {
    const result = validateRoleDocument({
      role_id: 'empty-text-role',
      name: 'Empty Text Role',
      description: '',
      system_prompt: '',
    }, 'old.yaml')

    expect(result.description).toBe('')
    expect(result.systemPrompt).toBe('')
  })

  it('uses a RoleSchemaError for invalid top-level values', () => {
    expect(() => validateRoleDocument([], 'test.yaml')).toThrow(RoleSchemaError)
  })

  it('loads a versioned YAML role through FileRoleProvider', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-versioned-role-'))
    const file = path.join(directory, 'test-role.yaml')
    await writeFile(file, [
      'api_version: dsh.orchestrator/v1alpha1',
      'kind: Role',
      'metadata:',
      '  role_id: provider-role',
      '  name: Provider Role',
      '  version: 1.0.0',
      '  description: Loaded from YAML',
      'system_prompt: You are a provider test',
      'execution:',
      '  harness: codex',
      '  keep_alive_after_task: false',
    ].join('\n'))

    try {
      const role = await new FileRoleProvider({ rolesDir: directory }).get('provider-role')
      expect(role).toMatchObject({ roleId: 'provider-role', name: 'Provider Role' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
