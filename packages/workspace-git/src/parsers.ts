import type { ParsedStatus, ParsedWorktree } from './types.js'

/**
 * Parse Git status --porcelain=v2 -z output.
 *
 * Format: Each entry is null-terminated, with fields space-separated.
 * - `1 XY ...` = ordinary changed entry
 * - `2 XY ...` = renamed/copied entry
 * - `? path` = untracked file
 * - `! path` = ignored file
 *
 * @param output - Raw output from `git status --porcelain=v2 -z`
 * @returns Parsed status with staged, unstaged, and untracked files
 */
export function parseStatusPorcelain(output: string): ParsedStatus {
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []

  if (output.length === 0) {
    return { staged, unstaged, untracked }
  }

  // `-z` is important here: paths may contain spaces, tabs, or newlines.
  // Split only on NUL and never use a shell-style whitespace parser.
  const entries = output.split('\0').filter((line) => line.length > 0)

  for (const entry of entries) {
    if (entry.startsWith('? ')) {
      // Untracked file
      untracked.push(entry.slice(2))
    } else if (entry.startsWith('! ')) {
      // Ignored file - skip
      continue
    } else if (
      entry.startsWith('1 ') ||
      entry.startsWith('2 ') ||
      entry.startsWith('u ')
    ) {
      // Ordinary, rename/copy, and unmerged records all carry XY in field 1.
      // The path starts at a fixed field and the remainder is kept verbatim.
      const firstSpace = entry.indexOf(' ')
      const secondSpace = firstSpace < 0 ? -1 : entry.indexOf(' ', firstSpace + 1)
      const xy = secondSpace < 0 ? undefined : entry.slice(firstSpace + 1, secondSpace)
      if (!xy || xy.length < 2) continue

      const x = xy[0] // Index status
      const y = xy[1] // Worktree status

      // Porcelain v2 field layout: ordinary has path at field 8, rename at
      // field 9, and unmerged at field 10. Joining the tail preserves spaces.
      const requiredSpaces = entry.startsWith('1 ')
        ? 8
        : entry.startsWith('2 ')
          ? 9
          : 10
      let cursor = -1
      for (let field = 0; field < requiredSpaces; field += 1) {
        const next = entry.indexOf(' ', cursor + 1)
        if (next < 0) break
        cursor = next
      }
      // Keep the exact tail, including spaces in a filename. Some synthetic
      // porcelain fixtures omit optional rename metadata, so use the last
      // available field when fewer separators are present.
      const path = cursor < 0 ? '' : entry.slice(cursor + 1)

      if (path.length === 0) continue

      // Check index status (X)
      if (x !== '.' && x !== ' ') {
        staged.push(path)
      }

      // Check worktree status (Y)
      if (y !== '.' && y !== ' ') {
        unstaged.push(path)
      }
    }
  }

  return { staged, unstaged, untracked }
}

/**
 * Parse Git worktree list --porcelain -z output.
 *
 * Format: Each worktree is a block of key-value pairs, blocks separated by null.
 * Example:
 * ```
 * worktree /path/to/worktree\0
 * HEAD abc123...\0
 * branch refs/heads/main\0
 * \0
 * worktree /path/to/other\0
 * HEAD def456...\0
 * detached\0
 * \0
 * ```
 *
 * @param output - Raw output from `git worktree list --porcelain -z`
 * @returns Array of parsed worktrees
 */
export function parseWorktreeList(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = []

  if (output.length === 0) {
    return worktrees
  }

  // Split by double null (block separator)
  const blocks = output.split('\0\0').filter((block) => block.length > 0)

  for (const block of blocks) {
    const lines = block.split('\0').filter((line) => line.length > 0)

    let path: string | undefined
    let commit: string | undefined
    let branch: string | undefined
    let bare = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        commit = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        bare = true
      } else if (line === 'detached') {
        // Detached HEAD state - no branch
        branch = undefined
      }
    }

    if (path && commit) {
      worktrees.push({ path, commit, branch, bare })
    }
  }

  return worktrees
}
