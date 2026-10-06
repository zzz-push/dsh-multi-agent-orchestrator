#!/usr/bin/env tsx
/**
 * DSH role-calling CLI — "guided mode" invocation surface.
 *
 * This is the thin
 * CLI a live agent session (Claude Code, or any Harness with generic shell
 * access) runs directly, guided by a workflow skill's SKILL.md prose or by
 * its own judgment, to call one DSH role for one task — spawn it, send the
 * task, print the reply, close it. No compiled workflow, no Scheduler, no
 * forced role binding: the caller decides when and which role to call.
 *
 * Usage:
 *   pnpm dsh:call-role <roleId> "<task text>" [--scenario <name>] [--cwd <path>] [--rolesDir <path>] [--timeout <ms>] [--journal <file>]
 *   pnpm dsh:call-role --list [--cwd <path>] [--rolesDir <path>]
 *
 * `--scenario` applies one of the role's scenarios — its own, or one its
 * project layer (`.dsh/project-layer/<roleId>.yaml`) adds — to this task:
 * that scenario's guidance goes in front of the task text, nothing else
 * does. `--list` prints every role with its scenarios and when each applies,
 * which is what a calling agent reads to pick one.
 *
 * `--journal` puts the event journal somewhere other than the default
 * `<cwd>/.dsh/runtime/call-role-events.jsonl`. Use it when the cwd is a
 * directory the role is meant to read in full — an evaluator's evidence
 * bundle, for instance — so the role's own history does not show up there
 * as an unexplained extra file.
 *
 * Examples:
 *   pnpm dsh:call-role example-builder "修复一个可复现的问题，并说明验证步骤"
 *   pnpm dsh:call-role example-advisor "帮我看看这个方案有没有明显的架构问题" --timeout 300000
 *
 * Exit code 0 with the reply text on stdout when the role answers; exit
 * code 1 with the error on stderr otherwise (unknown role/harness, policy
 * violation, timeout, ...) — stdout only ever carries the reply, so this
 * can be piped or captured directly.
 *
 * Scope: reads roles from a plain directory (`--rolesDir`, default
 * `<cwd>/.dsh/roles`) via FileRoleProvider — the same global role library
 * `AgentManager` always falls back to. It does not resolve a workflow Skill
 * Pack's own private `dsh/roles/` (see role-resolver.ts) — calling a
 * workflow-local role this way is not yet supported.
 */
import path from 'node:path'
import { AgentManager, ClaudeCodeChannel, CodexWebSocketChannel, FileRoleProvider, installShutdownHandlers, listScenarios } from '@dsh/agent-manager'

interface ParsedArgs {
  list: boolean
  roleId: string
  task: string
  scenario?: string
  cwd: string
  rolesDir: string
  timeoutMs?: number
  journalFile: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let cwd = process.cwd()
  let rolesDir: string | undefined
  let timeoutMs: number | undefined
  let journalFile: string | undefined
  let scenario: string | undefined
  let list = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') { list = true; continue }
    if (arg === '--scenario') { scenario = argv[index += 1]; continue }
    if (arg === '--cwd') { cwd = path.resolve(argv[index += 1] ?? ''); continue }
    if (arg === '--rolesDir') { rolesDir = argv[index += 1]; continue }
    if (arg === '--timeout') { timeoutMs = Number(argv[index += 1]); continue }
    if (arg === '--journal') { journalFile = path.resolve(argv[index += 1] ?? ''); continue }
    positional.push(arg ?? '')
  }
  const [roleId, task] = positional
  if (!list && (!roleId || !task)) {
    throw new Error('usage: call-role <roleId> "<task text>" [--scenario <name>] [--cwd <path>] [--rolesDir <path>] [--timeout <ms>] [--journal <file>]\n       call-role --list [--cwd <path>] [--rolesDir <path>]')
  }
  return {
    list,
    roleId: roleId ?? '',
    task: task ?? '',
    ...(scenario === undefined ? {} : { scenario }),
    cwd,
    rolesDir: rolesDir === undefined ? path.join(cwd, '.dsh/roles') : path.resolve(rolesDir),
    ...(timeoutMs === undefined || Number.isNaN(timeoutMs) ? {} : { timeoutMs }),
    journalFile: journalFile ?? path.join(cwd, '.dsh/runtime/call-role-events.jsonl'),
  }
}

/** Print every role and its scenarios: what a calling agent reads to choose. */
async function listRoles(rolesDir: string): Promise<void> {
  const provider = new FileRoleProvider({ rolesDir })
  for (const summary of await provider.list()) {
    const role = await provider.get(summary.roleId)
    if (role === undefined) continue
    const layer = role.projectLayer === undefined ? '' : `  +项目层 ${role.projectLayer.hash.slice(0, 12)}`
    process.stdout.write(`${role.roleId}  (${role.name} v${role.version}, ${role.execution.harness})${layer}\n`)
    const tools = (role.execution.tools as { mcp_servers?: unknown } | undefined)?.mcp_servers
    if (Array.isArray(tools) && tools.length > 0) process.stdout.write(`  第三方工具（声明）：${tools.join(', ')}\n`)
    const when = role.annotations?.['dsh.when_to_use']
    if (when !== undefined) process.stdout.write(`  何时调用：${when.trim().replace(/\s+/g, " ")}\n`)
    for (const scenario of listScenarios(role)) {
      process.stdout.write(`  --scenario ${scenario.name}${scenario.source === 'project' ? '（本项目）' : ''}：${scenario.title ?? scenario.name} — ${scenario.when.trim().replace(/\s+/g, ' ')}\n`)
    }
  }
}

async function main(): Promise<void> {
  installShutdownHandlers({ onSignal: (signal) => console.error(`[call-role] ${signal}: stopping the sub-agent…`) })
  const args = parseArgs(process.argv.slice(2))
  if (args.list) {
    await listRoles(args.rolesDir)
    return
  }
  const manager = new AgentManager({
    roleProvider: new FileRoleProvider({ rolesDir: args.rolesDir }),
    // Shared, append-only across every call-role invocation in this project —
    // one more real history alongside whatever else drives AgentManager here.
    journalFile: args.journalFile,
    cwd: args.cwd,
    channels: [
      new ClaudeCodeChannel({ command: 'claude' }),
      new CodexWebSocketChannel({ command: 'codex' }),
    ],
  })
  try {
    const handle = await manager.spawn({ roleId: args.roleId, cwd: args.cwd })
    try {
      const reply = await manager.sendChat(handle.agentId, args.task, {
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
      })
      process.stdout.write(`${reply.text}\n`)
      // The reply text alone was exactly what got mistaken for
      // "done" once already. When the role declares verification rules,
      // sendChat() now attaches their outcome — surface a loud, impossible
      // to miss warning on stderr rather than silently trusting the text.
      if (reply.verification !== undefined && !reply.verification.passed) {
        const failed = reply.verification.results.filter((result) => !result.passed)
        console.error(`[call-role] warning: this role's own verification rules did not pass (${failed.length}/${reply.verification.results.length} failed):`)
        for (const result of failed) console.error(`  - [${result.rule.type}] ${result.message ?? 'no message'}`)
      }
    } finally {
      await manager.close(handle.agentId)
    }
  } finally {
    await manager.dispose()
  }
}

main().catch((error: unknown) => {
  console.error(`[call-role] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
