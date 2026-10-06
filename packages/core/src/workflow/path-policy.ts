/**
 * Which paths a write step may change (a compiled step's `paths`), checked
 * against what its candidate commit actually changed: the controller obtains
 * the real diff and changed paths, requires a non-empty diff for write steps,
 * and applies every path rule. The agent's own account
 * of what it touched plays no part.
 *
 * Patterns are repository-relative POSIX globs: `*` and `?` stay within one
 * path segment, `**` spans any number of segments (including none), and a
 * pattern without glob characters also covers everything under it when it
 * names a directory (`docs` ≡ `docs/**`).
 */
export interface PathPolicy {
  allowChanges: readonly string[]
  denyChanges: readonly string[]
}

export interface PathPolicyResult {
  /** Changed paths no `allowChanges` pattern covers (only when there are allow patterns). */
  notAllowed: string[]
  /** Changed paths a `denyChanges` pattern covers. */
  denied: string[]
}

/** Evaluate a step's path policy against the paths its candidate changed. */
export function evaluatePathPolicy(changedPaths: readonly string[], policy: PathPolicy): PathPolicyResult {
  const allow = policy.allowChanges.map(globToRegExp)
  const deny = policy.denyChanges.map(globToRegExp)
  const notAllowed: string[] = []
  const denied: string[] = []
  for (const changed of changedPaths) {
    if (deny.some((pattern) => pattern.test(changed))) denied.push(changed)
    else if (allow.length > 0 && !allow.some((pattern) => pattern.test(changed))) notAllowed.push(changed)
  }
  return { notAllowed, denied }
}

/** A compiled step's path policy out of its metadata bag, when it declares one. */
export function readPathPolicy(metadata: Record<string, unknown> | undefined): PathPolicy | undefined {
  const paths = metadata?.paths
  if (typeof paths !== 'object' || paths === null) return undefined
  const record = paths as Record<string, unknown>
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const policy = { allowChanges: list(record.allow_changes), denyChanges: list(record.deny_changes) }
  return policy.allowChanges.length === 0 && policy.denyChanges.length === 0 ? undefined : policy
}

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const literal = !/[*?]/.test(glob)
  return new RegExp(`^${source}${literal ? '(?:/.*)?' : ''}$`)
}
