import { describe, it, expect } from 'vitest'
import { parseStatusPorcelain, parseWorktreeList } from '../src/parsers.js'

describe('parseStatusPorcelain', () => {
  it('returns empty arrays for clean working tree', () => {
    const result = parseStatusPorcelain('')

    expect(result).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
    })
  })

  it('parses untracked files', () => {
    const output = '? file1.txt\0? file2.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.untracked).toEqual(['file1.txt', 'file2.txt'])
    expect(result.staged).toEqual([])
    expect(result.unstaged).toEqual([])
  })

  it('parses staged files (index modified)', () => {
    const output = '1 M. N... 100644 100644 100644 abc123 def456 file.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toContain('file.txt')
    expect(result.unstaged).toEqual([])
    expect(result.untracked).toEqual([])
  })

  it('parses unstaged files (worktree modified)', () => {
    const output = '1 .M N... 100644 100644 100644 abc123 abc123 file.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toEqual([])
    expect(result.unstaged).toContain('file.txt')
    expect(result.untracked).toEqual([])
  })

  it('parses both staged and unstaged changes', () => {
    const output = '1 MM N... 100644 100644 100644 abc123 def456 file.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toContain('file.txt')
    expect(result.unstaged).toContain('file.txt')
    expect(result.untracked).toEqual([])
  })

  it('parses added files', () => {
    const output = '1 A. N... 000000 100644 100644 000000 abc123 new.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toContain('new.txt')
    expect(result.unstaged).toEqual([])
  })

  it('parses deleted files', () => {
    const output = '1 .D N... 100644 100644 000000 abc123 000000 deleted.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toEqual([])
    expect(result.unstaged).toContain('deleted.txt')
  })

  it('ignores ignored files', () => {
    const output = '! ignored.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toEqual([])
    expect(result.unstaged).toEqual([])
    expect(result.untracked).toEqual([])
  })

  it('parses mixed status', () => {
    const output =
      '1 M. N... 100644 100644 100644 abc123 def456 staged.txt\0' +
      '1 .M N... 100644 100644 100644 ghi789 ghi789 unstaged.txt\0' +
      '? untracked.txt\0'

    const result = parseStatusPorcelain(output)

    expect(result.staged).toContain('staged.txt')
    expect(result.unstaged).toContain('unstaged.txt')
    expect(result.untracked).toContain('untracked.txt')
  })

  it('handles renamed files', () => {
    const output = '2 R. N... 100644 100644 100644 abc123 abc123 newname.txt\0'
    const result = parseStatusPorcelain(output)

    expect(result.staged).toContain('newname.txt')
  })
})

describe('parseWorktreeList', () => {
  it('returns empty array for no worktrees', () => {
    const result = parseWorktreeList('')

    expect(result).toEqual([])
  })

  it('parses single worktree', () => {
    const output =
      'worktree /path/to/repo\0' +
      'HEAD abc123def456789012345678901234567890ab\0' +
      'branch refs/heads/main\0' +
      '\0'

    const result = parseWorktreeList(output)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      path: '/path/to/repo',
      commit: 'abc123def456789012345678901234567890ab',
      branch: 'refs/heads/main',
      bare: false,
    })
  })

  it('parses detached HEAD worktree', () => {
    const output =
      'worktree /path/to/worktree\0' +
      'HEAD def456789012345678901234567890abcdef12\0' +
      'detached\0' +
      '\0'

    const result = parseWorktreeList(output)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      path: '/path/to/worktree',
      commit: 'def456789012345678901234567890abcdef12',
      branch: undefined,
      bare: false,
    })
  })

  it('parses multiple worktrees', () => {
    const output =
      'worktree /path/to/main\0' +
      'HEAD aaa111222333444555666777888999000aaabbb\0' +
      'branch refs/heads/main\0' +
      '\0' +
      'worktree /path/to/feature\0' +
      'HEAD bbb222333444555666777888999000aaabbbccc\0' +
      'branch refs/heads/feature\0' +
      '\0' +
      'worktree /path/to/detached\0' +
      'HEAD ccc333444555666777888999000aaabbbcccddd\0' +
      'detached\0' +
      '\0'

    const result = parseWorktreeList(output)

    expect(result).toHaveLength(3)
    expect(result[0]?.path).toBe('/path/to/main')
    expect(result[1]?.path).toBe('/path/to/feature')
    expect(result[2]?.path).toBe('/path/to/detached')
    expect(result[2]?.branch).toBeUndefined()
  })

  it('parses bare repository', () => {
    const output =
      'worktree /path/to/bare\0' +
      'bare\0' +
      '\0'

    const result = parseWorktreeList(output)

    expect(result).toHaveLength(0) // Bare worktree has no commit
  })
})
