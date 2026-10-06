import { describe, expect, it } from 'vitest'

import { evaluatePathPolicy, globToRegExp, readPathPolicy } from '../../src/workflow/path-policy.js'

describe('path policy globs', () => {
  it('keeps * and ? within a segment, lets ** span segments, and treats a plain directory as everything under it', () => {
    const matches = (glob: string, file: string) => globToRegExp(glob).test(file)
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(matches('src/**', 'src/deep/er/a.ts')).toBe(true)
    expect(matches('src/**/*.test.ts', 'src/a.test.ts')).toBe(true)
    expect(matches('src/**/*.test.ts', 'src/x/y/a.test.ts')).toBe(true)
    expect(matches('packages/*/README.md', 'packages/core/README.md')).toBe(true)
    expect(matches('packages/*/README.md', 'packages/core/src/README.md')).toBe(false)
    expect(matches('file?.md', 'file1.md')).toBe(true)
    expect(matches('docs', 'docs/a/b.md')).toBe(true)
    expect(matches('docs', 'docs')).toBe(true)
    expect(matches('docs', 'docsx/a.md')).toBe(false)
    expect(matches('a.b', 'aXb')).toBe(false)
  })

  it('reports paths outside the allow list and paths a deny pattern covers — deny wins', () => {
    expect(evaluatePathPolicy(['docs/a.md', 'src/x.ts', 'docs/secret/k.md'], { allowChanges: ['docs/**'], denyChanges: ['docs/secret/**'] }))
      .toEqual({ notAllowed: ['src/x.ts'], denied: ['docs/secret/k.md'] })
    // No allow list: everything not denied is fine.
    expect(evaluatePathPolicy(['anything.ts'], { allowChanges: [], denyChanges: ['.github/**'] })).toEqual({ notAllowed: [], denied: [] })
  })

  it('reads a compiled step\'s policy from its metadata, and nothing from a step without one', () => {
    expect(readPathPolicy({ paths: { allow_changes: ['src/**'], deny_changes: [] } })).toEqual({ allowChanges: ['src/**'], denyChanges: [] })
    expect(readPathPolicy({ paths: { allow_changes: [], deny_changes: [] } })).toBeUndefined()
    expect(readPathPolicy({})).toBeUndefined()
    expect(readPathPolicy(undefined)).toBeUndefined()
  })
})
