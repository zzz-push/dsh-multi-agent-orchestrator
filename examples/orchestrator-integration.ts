#!/usr/bin/env tsx
/**
 * End-to-end integration test for orchestrator → scheduler → agent execution
 *
 * This demonstrates:
 * 1. Loading orchestrator plugin with all services
 * 2. Creating a run with steps
 * 3. Scheduler executing steps via AgentManager
 */

import { Context } from '@deepseek-ai/cordis'
import DshOrchestratorPlugin, { communicationRegistryService, coreSchedulerService } from '@dsh/orchestrator'
import CommEventBusPlugin from '@dsh/comm-eventbus'
import DshAgentManagerPlugin from '@dsh/agent-manager'
import { createRunAggregate } from '@dsh/core'

async function main() {
  console.log('🚀 Starting orchestrator integration test...\n')

  // Create Cordis context and load all plugins
  const ctx = new Context()

  console.log('📦 Loading plugins...')
  const orchestrator = await ctx.plugin(DshOrchestratorPlugin, {
    drainTimeoutMs: 5000,
    openTimeoutMs: 5000,
    globalMaxParallel: 2,
  })

  const eventBus = await ctx.plugin(CommEventBusPlugin, {
    maxListeners: 10,
  })

  const agentManager = await ctx.plugin(DshAgentManagerPlugin, {
    rolesDir: '.dsh/roles',
    journalFile: '.dsh/runtime/agent-events.jsonl',
  })

  console.log('✅ All plugins loaded\n')

  // Get services from context
  const registry = ctx.get(communicationRegistryService)
  const scheduler = ctx.get(coreSchedulerService)

  if (!registry) {
    throw new Error('CommunicationRegistry not available')
  }

  if (!scheduler) {
    throw new Error('Scheduler not available')
  }

  console.log('✅ Services available:')
  console.log(`   - CommunicationRegistry: ${registry ? 'YES' : 'NO'}`)
  console.log(`   - Scheduler: ${scheduler ? 'YES' : 'NO'}`)
  console.log(`   - Registry providers: ${registry.inspect().providers.length}`)
  console.log()

  // Create a test run
  console.log('📝 Creating test run...')
  const runId = 'test-run-' + Date.now()

  const run = createRunAggregate({
    id: runId,
    repository: {
      root: process.cwd(),
      baseCommit: 'HEAD',
    },
    steps: [
      {
        id: 'step-1',
        dependencies: [],
      },
    ],
  })

  const createdRun = await scheduler.createRun(run)

  console.log(`✅ Run created: ${runId}`)
  console.log(`   - Steps: ${Object.keys(createdRun.steps).length}`)
  console.log()

  // Start the run
  console.log('▶️  Starting run...')
  const result = await scheduler.start(runId)

  console.log(`✅ Run completed with status: ${result.status}`)
  console.log(`   - Steps:`)
  for (const [stepId, step] of Object.entries(result.steps)) {
    console.log(`     - ${stepId}: ${step.status}`)
  }
  console.log()

  // Cleanup
  console.log('🧹 Cleaning up...')
  await agentManager.dispose()
  await eventBus.dispose()
  await orchestrator.dispose()

  console.log('✅ Integration test complete!')
}

main().catch((error) => {
  console.error('❌ Test failed:', error)
  process.exit(1)
})
