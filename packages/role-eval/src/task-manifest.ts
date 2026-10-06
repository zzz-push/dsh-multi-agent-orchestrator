import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'yaml'

/** One controller-side check, as written in a task manifest. */
export interface TaskCheck {
  name: string
  command: string
  timeoutMs?: number
}

/**
 * A task manifest is the "same dish" both role versions must cook: the
 * exact instructions, the exact starting commit, and the exact checks the
 * controller runs afterwards. Everything a comparison holds constant lives
 * here, so two arms of one comparison differ in nothing but the role.
 */
export interface TaskManifest {
  /** Stable id; becomes the step id and part of the comparison id. Safe-name only. */
  id: string
  title: string
  /** Role id both arms are spawned with. */
  role: string
  /** Commit every arm's worktree starts from. Resolved to a full sha at load time by the caller. */
  baseCommit: string
  /** Verbatim instructions sent to the role as one chat turn. */
  instructions: string
  /**
   * Commands run controller-side in each fresh worktree before the role is
   * let in (`pnpm install`, fixtures, ...). Same shape and semantics as
   * `checks`; a failure fails the arm before any agent is spawned.
   */
  setup?: TaskCheck[]
  /**
   * The gate: checks run in the worktree after the role finishes, in
   * order; the first failure fails the step. The role can read these — and
   * `pnpm test` runs the tests the role itself wrote — so passing them
   * means "nothing is obviously broken", not "the task was done".
   */
  checks: TaskCheck[]
  /**
   * The score: checks the role never sees, run afterwards against the
   * captured candidate commit in a throwaway worktree. Written against the
   * task's observable contract, so that two correct solutions with
   * different internal shapes both pass. Failing one does not fail the
   * step — it lowers the arm's correctness score.
   */
  hiddenChecks?: TaskCheck[]
  /**
   * Directory copied over the scoring checkout before the hidden checks
   * run, resolved relative to the manifest file. Its layout is the
   * destination layout (`packages/x/test/hidden.test.ts` lands there).
   */
  hiddenFilesDir?: string
  /** Wall-clock cap on the role's turn. Default: the executor's (one hour). */
  timeoutMs?: number
  /**
   * Harness sandbox mode every arm runs under (`workspace-write`,
   * `acceptEdits`, ...). Part of the task environment, not of the role: a
   * task that needs the worktree written to says so here, so both arms get
   * it whether or not their role declares one. Still subject to the project
   * policy at `base_commit`. Default: whatever the role declares.
   */
  sandbox?: string
  /**
   * Harness every arm runs on (`codex` / `claude-code`), overriding what each
   * role declares. Task environment, like `sandbox`: the role files and their
   * hashes stay untouched. Default: whatever the role declares.
   */
  harness?: string
  /**
   * `keep` (default) or `hide` the project's own harness instructions
   * (CLAUDE.md, AGENTS.md, .claude/skills, ...) during the role's turn — see
   * `HarnessContextMode`. Task environment, identical for every arm.
   */
  harnessContext?: 'keep' | 'hide'
  /** Absolute path the manifest was loaded from, for the record. */
  file?: string
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Parse and validate a task manifest document. Throws with a field-level message on any defect. */
export function parseTaskManifest(text: string, file?: string): TaskManifest {
  const raw: unknown = parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`task manifest${where(file)}: top level must be a mapping`)
  }
  const doc = raw as Record<string, unknown>
  const id = requireString(doc, 'id', file)
  if (!SAFE_ID.test(id)) throw new Error(`task manifest${where(file)}: id ${JSON.stringify(id)} is not a safe name`)
  const checks = parseCommandList(doc, 'checks', file, { required: true })!
  const setup = parseCommandList(doc, 'setup', file, { required: false })
  const hiddenChecks = parseCommandList(doc, 'hidden_checks', file, { required: false })
  const hiddenFilesRaw = optionalString(doc, 'hidden_files', file)
  if (hiddenFilesRaw !== undefined && file === undefined) {
    throw new Error('task manifest: hidden_files needs the manifest path to resolve against')
  }
  const hiddenFilesDir = hiddenFilesRaw === undefined ? undefined : path.resolve(path.dirname(file!), hiddenFilesRaw)
  const timeoutMs = optionalPositiveInt(doc, 'timeout_ms', file)
  const sandbox = optionalString(doc, 'sandbox', file)
  const harness = optionalString(doc, 'harness', file)
  const harnessContext = optionalString(doc, 'harness_context', file)
  if (harnessContext !== undefined && harnessContext !== 'keep' && harnessContext !== 'hide') {
    throw new Error(`task manifest${where(file)}: harness_context must be "keep" or "hide"`)
  }
  return {
    id,
    title: requireString(doc, 'title', file),
    role: requireString(doc, 'role', file),
    baseCommit: requireString(doc, 'base_commit', file),
    instructions: requireString(doc, 'instructions', file),
    ...(setup === undefined ? {} : { setup }),
    checks,
    ...(hiddenChecks === undefined ? {} : { hiddenChecks }),
    ...(hiddenFilesDir === undefined ? {} : { hiddenFilesDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(harness === undefined ? {} : { harness }),
    ...(harnessContext === undefined ? {} : { harnessContext }),
    ...(file === undefined ? {} : { file }),
  }
}

/** Read a manifest file from disk. */
export async function loadTaskManifest(file: string): Promise<TaskManifest> {
  const absolute = path.resolve(file)
  return parseTaskManifest(await readFile(absolute, 'utf8'), absolute)
}

function requireString(doc: Record<string, unknown>, key: string, file: string | undefined, prefix = ''): string {
  const value = doc[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`task manifest${where(file)}: ${prefix}${key} must be a non-empty string`)
  }
  return value
}

function parseCommandList(
  doc: Record<string, unknown>,
  key: string,
  file: string | undefined,
  options: { required: boolean },
): TaskCheck[] | undefined {
  const raw = doc[key]
  if (raw === undefined && !options.required) return undefined
  if (!Array.isArray(raw) || (options.required && raw.length === 0)) {
    throw new Error(`task manifest${where(file)}: ${key} must be a ${options.required ? 'non-empty ' : ''}list`)
  }
  return raw.map((entry, index): TaskCheck => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`task manifest${where(file)}: ${key}[${index}] must be a mapping`)
    const check = entry as Record<string, unknown>
    const name = requireString(check, 'name', file, `${key}[${index}].`)
    const command = requireString(check, 'command', file, `${key}[${index}].`)
    const timeoutMs = optionalPositiveInt(check, 'timeout_ms', file, `${key}[${index}].`)
    return { name, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  })
}

function optionalString(doc: Record<string, unknown>, key: string, file: string | undefined): string | undefined {
  const value = doc[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`task manifest${where(file)}: ${key} must be a non-empty string when present`)
  }
  return value
}

function optionalPositiveInt(doc: Record<string, unknown>, key: string, file: string | undefined, prefix = ''): number | undefined {
  const value = doc[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`task manifest${where(file)}: ${prefix}${key} must be a positive integer`)
  }
  return value
}

function where(file: string | undefined): string {
  return file === undefined ? '' : ` (${file})`
}
