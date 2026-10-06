import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * Runtime configuration accepted by the agent-manager Cordis plugin.
 *
 * Relative paths resolve against `root`, never against the process working
 * directory: the DSH desktop app is started from the Dock, where that is `/`.
 * `~/` at the start of a path or command means the home directory.
 */
export const DshAgentManagerConfigSchema = z.object({
  /**
   * Directory relative paths resolve against. Default: the repository this
   * plugin runs from ({@link PLUGIN_CHECKOUT_ROOT}) — a DSH profile links the
   * plugin from its checkout, so `.dsh/roles` there is this project's roles.
   */
  root: z.string().optional(),
  /** Directory containing role-pack YAML files. */
  rolesDir: z.string().default('.dsh/roles'),
  /** Append-only journal path. */
  journalFile: z.string().default('.dsh/runtime/agent-events.jsonl'),
  /** Default working directory for child processes. Default: `root`. */
  cwd: z.string().optional(),
  /** Claude executable name/path. */
  claudeCommand: z.string().default('claude'),
  /**
   * Model for Claude sub-agents. Omitted: the channel default (`sonnet`, see
   * DEFAULT_CLAUDE_SUBAGENT_MODEL). `null`: no `--model` flag, the CLI default.
   */
  claudeModel: z.string().nullable().optional(),
  /** Thinking effort for Claude sub-agents. Omitted: `medium`. `null`: no `--effort` flag. */
  claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  /** Codex executable name/path. */
  codexCommand: z.string().default('codex'),
  /** Optional Codex state/config directory applied to app-server and TUI. */
  codexHome: z.string().optional(),
  /** tmux executable name/path used by Codex TUI agents. */
  tmuxCommand: z.string().default('tmux'),
  /**
   * Host names besides `localhost` and IP addresses the Agent window routes
   * accept (`host` for any port, `host:port` for one). Give the same values
   * DSH is served with via `--trusted-host`; see `web.ts`.
   */
  trustedHosts: z.array(z.string()).default([]),
}).strict()

export type DshAgentManagerConfig = z.infer<typeof DshAgentManagerConfigSchema>

/**
 * The repository this module was loaded from: `<root>/packages/agent-manager/`
 * holds it under `src/` (tests) or `dist/` (DSH), one level down either way.
 */
export const PLUGIN_CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The configuration with every path absolute and `~/` expanded. */
export interface ResolvedAgentManagerPaths {
  root: string
  rolesDir: string
  journalFile: string
  cwd: string
  codexHome?: string
  claudeCommand: string
  codexCommand: string
}

/** `~/x` → `<home>/x`; anything else unchanged. */
export function expandHome(value: string, home: string = homedir()): string {
  return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value
}

/**
 * Make the configured paths absolute against `root` (itself relative to the
 * checkout). Commands stay bare names unless written as a path: a bare name is
 * looked up on PATH when the agent starts.
 */
export function resolveAgentManagerPaths(
  config: DshAgentManagerConfig,
  checkoutRoot: string = PLUGIN_CHECKOUT_ROOT,
  home: string = homedir(),
): ResolvedAgentManagerPaths {
  const root = path.resolve(checkoutRoot, expandHome(config.root ?? '.', home))
  const at = (value: string): string => path.resolve(root, expandHome(value, home))
  const command = (value: string): string => (value.includes('/') || value.startsWith('~') ? at(value) : value)
  return {
    root,
    rolesDir: at(config.rolesDir),
    journalFile: at(config.journalFile),
    cwd: at(config.cwd ?? '.'),
    ...(config.codexHome === undefined ? {} : { codexHome: at(config.codexHome) }),
    claudeCommand: command(config.claudeCommand),
    codexCommand: command(config.codexCommand),
  }
}
