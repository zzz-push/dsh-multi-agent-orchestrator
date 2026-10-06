#!/usr/bin/env tsx
/**
 * DSH evaluation evidence CLI — the mechanical half of scorecard layer 4.
 *
 * Builds the directory the `example-evaluator` role works in (its cwd; it has
 * Read / Grep / Glob and nothing else). What goes in front of the evaluator
 * is decided here, by code, so that the agent driving an evaluation — which
 * may have seen the results, or written one of the solutions — does not
 * get to choose.
 *
 * Usage:
 *   pnpm dsh:eval-bundle <comparison.json | its directory> \
 *     --phase rubric|grade [--blind] [--seed <n>] [--out <dir>]
 *
 * Typical sequence (the skill evaluator-skill drives it):
 *   pnpm dsh:eval-bundle .dsh/eval/records/<rec> --phase rubric --blind
 *   … evaluator writes the rubric …
 *   pnpm dsh:eval-bundle .dsh/eval/records/<rec> --phase grade --blind
 *
 * `--phase rubric` writes the task and both role definitions only — no
 * results — so the scoring criteria are fixed before anyone knows who won.
 * `--phase grade` rebuilds the same directory with results added.
 *
 * `--blind` renames arms to A/B and hides role versions. The mapping is
 * written next to the bundle (`<out>.blinding.json`), outside the
 * evaluator's reach, and reused by every later build of the same bundle.
 *
 * Default --out: <repo>/.dsh/runtime/evaluations/<record id>/bundle.
 * stdout carries only the bundle path; details go to stderr.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { buildEvidenceBundle, type EvidencePhase } from '@dsh/role-eval'

interface ParsedArgs {
  record: string
  phase: EvidencePhase
  blind: boolean
  seed?: number
  out?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let phase: string | undefined
  let blind = false
  let seed: number | undefined
  let out: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--phase') { phase = argv[index += 1]; continue }
    if (arg === '--blind') { blind = true; continue }
    if (arg === '--seed') { seed = Number(argv[index += 1]); continue }
    if (arg === '--out') { out = argv[index += 1]; continue }
    positional.push(arg ?? '')
  }
  const [record] = positional
  if (record === undefined || (phase !== 'rubric' && phase !== 'grade')) {
    throw new Error('usage: eval-bundle <comparison.json | dir> --phase rubric|grade [--blind] [--seed <n>] [--out <dir>]')
  }
  if (seed !== undefined && (!Number.isInteger(seed) || seed <= 0)) throw new Error('--seed must be a positive integer')
  return { record, phase, blind, ...(seed === undefined ? {} : { seed }), ...(out === undefined ? {} : { out }) }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const recordPath = path.resolve(args.record)
  const recordFile = (await stat(recordPath)).isDirectory() ? path.join(recordPath, 'comparison.json') : recordPath
  const { id } = JSON.parse(await readFile(recordFile, 'utf8')) as { id: string }
  const out = path.resolve(args.out ?? path.join(process.cwd(), '.dsh', 'runtime', 'evaluations', id, 'bundle'))

  const result = await buildEvidenceBundle({
    record: recordFile,
    outDir: out,
    phase: args.phase,
    blind: args.blind,
    ...(args.seed === undefined ? {} : { seed: args.seed }),
  })

  console.error(`[eval-bundle] record    ${id}`)
  console.error(`[eval-bundle] phase     ${result.phase}`)
  console.error(`[eval-bundle] files     ${result.files.length} (${result.files.filter((file) => file.startsWith('results/')).length} under results/)`)
  console.error(`[eval-bundle] hash      ${result.contentHash}`)
  if (result.blinding !== undefined) {
    console.error(`[eval-bundle] blinding  ${result.blinding.file}  (seed ${result.blinding.mapping.seed}; do not show this to the evaluator)`)
  }
  for (const caveat of result.caveats) console.error(`[eval-bundle] note: ${caveat}`)
  process.stdout.write(`${result.outDir}\n`)
}

main().catch((error: unknown) => {
  console.error(`[eval-bundle] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
