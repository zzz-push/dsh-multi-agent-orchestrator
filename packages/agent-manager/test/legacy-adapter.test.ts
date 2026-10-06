import { describe, expect, it } from 'vitest'
import { adaptLegacyRoleDocument, LegacyRoleFormatError } from '../src/role/legacy-adapter.js'

describe('adaptLegacyRoleDocument', () => {
  it('applies defaults when execution is omitted entirely', () => {
    const role = adaptLegacyRoleDocument({ role_id: 'r1', name: 'Role One' })

    expect(role.execution).toEqual({
      harness: 'claude-code',
      keepAliveAfterTask: true,
      chatTimeoutMs: 600_000,
    })
  })

  it('rejects an interactionMode value outside headless/interactive', () => {
    expect(() =>
      adaptLegacyRoleDocument({
        role_id: 'r1',
        name: 'Role One',
        execution: { interactionMode: 'bogus' },
      }),
    ).toThrow(LegacyRoleFormatError)
  })

  it('rejects an execution block that is not an object', () => {
    expect(() =>
      adaptLegacyRoleDocument({ role_id: 'r1', name: 'Role One', execution: 'not-an-object' }),
    ).toThrow(LegacyRoleFormatError)

    expect(() =>
      adaptLegacyRoleDocument({ role_id: 'r1', name: 'Role One', execution: null }),
    ).toThrow(LegacyRoleFormatError)

    expect(() =>
      adaptLegacyRoleDocument({ role_id: 'r1', name: 'Role One', execution: [] }),
    ).toThrow(LegacyRoleFormatError)
  })
})
