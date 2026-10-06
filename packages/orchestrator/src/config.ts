import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Runtime configuration accepted by the DSH orchestrator Cordis plugin. */
export const DshOrchestratorConfigSchema = z.object({
  drainTimeoutMs: z.number().int().positive().default(60_000),
  openTimeoutMs: z.number().int().positive().default(10_000),
  globalMaxParallel: z.number().int().positive().default(4),
  /**
   * Directory a relative `runsDir` resolves against. Default: the repository
   * this plugin runs from ({@link PLUGIN_CHECKOUT_ROOT}), never the process
   * working directory — the DSH desktop host runs in its profile directory,
   * where runs would land apart from the ones `pnpm dsh:start-workflow` keeps.
   */
  root: z.string().optional(),
  /**
   * Directory the durable `RunRepository` keeps one JSON document per run in
   *, relative to `root` unless absolute — the same place as the
   * agent journal of `@dsh/agent-manager`. Runs are project state, so the
   * default sits under `.dsh/runtime/`, which is already git-ignored.
   */
  runsDir: z.string().default('.dsh/runtime/runs'),
  /**
   * On startup, take over runs a stopped process left mid-flight
   * (`Scheduler.recoverAbandoned()`): their live steps are marked
   * `interrupted` and each run is logged with the command that resumes it.
   * Nothing is re-run automatically — that spends quota and waits for
   * `pnpm dsh:start-workflow --resume <runId>`.
   */
  recoverOnStart: z.boolean().default(true),
}).strict()

export type DshOrchestratorConfig = z.infer<typeof DshOrchestratorConfigSchema>

/**
 * The repository this module was loaded from: `<root>/packages/orchestrator/`
 * holds it under `src/` (tests) or `dist/` (DSH), one level down either way.
 */
export const PLUGIN_CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Absolute runs directory: `runsDir` against `root`, `root` against the checkout. */
export function resolveRunsDir(config: Pick<DshOrchestratorConfig, 'root' | 'runsDir'>, checkoutRoot: string = PLUGIN_CHECKOUT_ROOT): string {
  return path.resolve(checkoutRoot, config.root ?? '.', config.runsDir)
}
