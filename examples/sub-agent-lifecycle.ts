import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AgentManager,
  ClaudeCodeChannel,
  FileRoleProvider,
  type RoleDefinition,
  type RoleProvider,
  type RoleSummary,
} from '@dsh/agent-manager'

/**
 * The repository roles intentionally default to codex. For this demo we use
 * the real role file as the prompt source and select Claude Code explicitly so
 * the requested Claude lifecycle is exercised without changing project roles.
 */
class DemoRoleProvider implements RoleProvider {
  private readonly source: FileRoleProvider
  private readonly roles = new Map<string, RoleDefinition>()

  constructor(rolesDir: string) {
    this.source = new FileRoleProvider({ rolesDir })
  }

  async get(roleId: string): Promise<RoleDefinition | undefined> {
    const existing = this.roles.get(roleId)
    if (existing !== undefined) return existing
    const base = await this.source.get('example-writer')
    if (base === undefined) return undefined
    if (roleId === 'demo-claude-kept' || roleId === 'demo-claude-one-shot') {
      const keepAliveAfterTask = roleId === 'demo-claude-kept'
      const role: RoleDefinition = {
        ...base,
        roleId,
        name: keepAliveAfterTask ? 'Demo Claude (kept)' : 'Demo Claude (one-shot)',
        systemPrompt: [
          'You are running the DSH agent-manager lifecycle demo.',
          'Do not use tools. Reply concisely and follow the requested format.',
          base.systemPrompt,
        ].join('\n\n'),
        execution: {
          ...base.execution,
          harness: 'claude-code',
          keepAliveAfterTask,
          chatTimeoutMs: 120_000,
        },
      }
      this.roles.set(roleId, role)
      return role
    }
    return undefined
  }

  async list(): Promise<RoleSummary[]> {
    return [...this.roles.values()].map((role) => ({
      roleId: role.roleId,
      name: role.name,
      version: role.version,
      harness: role.execution.harness,
      keepAliveAfterTask: role.execution.keepAliveAfterTask,
    }))
  }
}

async function main(): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dsh-agent-demo-'))
  const journalFile = path.join(runtimeDir, 'events.jsonl')
  const manager = new AgentManager({
    roleProvider: new DemoRoleProvider(path.resolve('.dsh/roles')),
    journalFile,
    channels: [new ClaudeCodeChannel()],
    cwd: process.cwd(),
  })

  try {
    console.log('1. Opening a real Claude Code child with a role system prompt...')
    const kept = await manager.spawn('demo-claude-kept')
    console.log(`   agentId=${kept.agentId} sessionId=${kept.harnessSessionId}`)

    console.log('2. Sending a structured task...')
    await manager.sendCommand(kept.agentId, {
      kind: 'task',
      payload: { operation: 'remember arithmetic result' },
      text: 'Compute 17 * 19. Reply with the phrase task-complete, but remember the number for the next turn.',
    })

    console.log('3. Sending a free-form chat turn...')
    const reply = await manager.sendChat(
      kept.agentId,
      'What number did you compute? Reply with the number only.',
    )
    console.log(`   reply=${JSON.stringify(reply.text)}`)

    console.log('4. Reading journal pages with a cursor and kind filter...')
    const firstPage = await manager.readConversation({
      agentId: kept.agentId,
      kinds: ['message'],
      limit: 3,
    })
    console.log(`   page1 items=${firstPage.items.length} nextCursor=${firstPage.nextCursor ?? '(none)'}`)
    if (firstPage.nextCursor !== undefined) {
      const secondPage = await manager.readConversation({
        agentId: kept.agentId,
        after: firstPage.nextCursor,
        kinds: ['message'],
        limit: 3,
      })
      console.log(`   page2 items=${secondPage.items.length} nextCursor=${secondPage.nextCursor ?? '(none)'}`)
    }

    console.log('5. keepAliveAfterTask=true: explicitly closing the retained process...')
    await manager.close(kept.agentId)
    console.log(`   status=${manager.get(kept.agentId)?.status ?? 'unknown'}`)

    console.log('6. keepAliveAfterTask=false: command completion closes the process automatically...')
    const oneShot = await manager.spawn('demo-claude-one-shot')
    await manager.sendCommand(oneShot.agentId, {
      kind: 'task',
      payload: { operation: 'one-shot lifecycle' },
      text: 'Reply with exactly one short sentence: one-shot complete.',
    })
    console.log(`   status=${manager.get(oneShot.agentId)?.status ?? 'unknown'}`)
    console.log(`journal=${journalFile}`)
  } finally {
    await manager.dispose()
    await rm(runtimeDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
