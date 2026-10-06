import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentManagerExecutor } from '../src/executor.js'
import type { AgentManager } from '../src/manager.js'
import type { AgentInfo } from '../src/types.js'
import type { AgentExecutionRequest } from '@dsh/core'
import { ChannelAbortedError, ChannelTimeoutError } from '../src/errors.js'

describe('AgentManagerExecutor', () => {
  let mockManager: AgentManager
  let executor: AgentManagerExecutor

  beforeEach(() => {
    // Create mock AgentManager
    mockManager = {
      spawn: vi.fn(),
      sendCommand: vi.fn(),
      sendChat: vi.fn(),
      get: vi.fn(),
      close: vi.fn(),
      readConversation: vi.fn(),
      dispose: vi.fn(),
    } as unknown as AgentManager

    executor = new AgentManagerExecutor(mockManager)
  })

  describe('start', () => {
    it('should spawn agent with correct environment variables', async () => {
      const request: AgentExecutionRequest = {
        runId: 'test-run-1',
        stepId: 'step-1',
        attempt: 1,
        inputCommit: 'abc123',
        workspaceId: 'ws-1',
        worktreePath: '/tmp/worktree-1',
        prompt: 'Execute the test task',
      }

      const mockAgent: AgentInfo = {
        agentId: 'agent-123',
        roleId: 'default-worker',
        status: 'ready',
        spawnedAt: Date.now(),
      }

      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })

      await executor.start(request)

      expect(mockManager.spawn).toHaveBeenCalledWith({
        roleId: 'default-worker',
        cwd: '/tmp/worktree-1',
        env: {
          DSH_RUN_ID: 'test-run-1',
          DSH_STEP_ID: 'step-1',
          DSH_ATTEMPT: '1',
          DSH_INPUT_COMMIT: 'abc123',
          DSH_WORKSPACE_ID: 'ws-1',
          DSH_WORKTREE_PATH: '/tmp/worktree-1',
        },
      })
    })

    it('sends the step instructions as one chat turn, with the request signal', async () => {
      const request: AgentExecutionRequest = {
        runId: 'test-run-1',
        stepId: 'step-1',
        attempt: 1,
        inputCommit: 'abc123',
        prompt: 'Custom prompt',
      }

      const mockAgent: AgentInfo = {
        agentId: 'agent-123',
        roleId: 'default-worker',
        status: 'ready',
        spawnedAt: Date.now(),
      }

      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })

      await executor.start(request)

      expect(mockManager.sendChat).toHaveBeenCalledWith('agent-123', 'Custom prompt', { signal: undefined })
      expect(mockManager.sendCommand).not.toHaveBeenCalled()
    })

    it('carries the reply facts into the completion: summary, model, tool-call count, role verification', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123', prompt: 'p' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({
        text: '## 实现概述\n做完了',
        model: 'gpt-5.4',
        stopReason: 'end_turn',
        durationMs: 1234,
        toolCalls: [
          { name: 'shell', input: {} } as never,
          { name: 'apply_patch', input: {} } as never,
        ],
        verification: {
          passed: false,
          results: [
            { rule: { type: 'output_structure' }, passed: true } as never,
            { rule: { type: 'content_policy' }, passed: false, message: 'missing section' } as never,
          ],
        },
      })

      const completion = await (await executor.start(request)).wait()
      expect(completion).toMatchObject({
        outcome: 'succeeded',
        agentId: 'agent-123',
        summary: '## 实现概述\n做完了',
        model: 'gpt-5.4',
        stopReason: 'end_turn',
        toolCalls: 2,
        verification: { passed: false, failedRules: 1, totalRules: 2 },
      })
    })

    it('leaves verification absent — never faked as passed — when the role declares no rules', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'ok', durationMs: 1, toolCalls: [] })
      const completion = await (await executor.start(request)).wait()
      expect(completion.toolCalls).toBe(0)
      expect('verification' in completion).toBe(false)
    })

    it('should use request.roleId when provided instead of the default-worker fallback', async () => {
      const request: AgentExecutionRequest = {
        runId: 'test-run-1',
        stepId: 'step-1',
        attempt: 1,
        inputCommit: 'abc123',
        roleId: 'custom-role',
      }

      const mockAgent: AgentInfo = {
        agentId: 'agent-123',
        roleId: 'custom-role',
        status: 'ready',
        spawnedAt: Date.now(),
      }

      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })

      await executor.start(request)

      expect(mockManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ roleId: 'custom-role' }),
      )
    })

    it('forwards the request sandbox to spawn, and leaves it out when absent', async () => {
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'r', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })
      const base: AgentExecutionRequest = { runId: 'run', stepId: 'step', attempt: 1, inputCommit: 'abc', roleId: 'r' }

      await executor.start({ ...base, sandbox: 'workspace-write', harness: 'claude-code' })
      expect(mockManager.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ sandbox: 'workspace-write', harness: 'claude-code' }))

      await executor.start(base)
      expect(mockManager.spawn).toHaveBeenLastCalledWith(expect.not.objectContaining({ sandbox: expect.anything() }))
      expect(mockManager.spawn).toHaveBeenLastCalledWith(expect.not.objectContaining({ harness: expect.anything() }))
    })

    it('should use default prompt if not provided', async () => {
      const request: AgentExecutionRequest = {
        runId: 'test-run-1',
        stepId: 'step-1',
        attempt: 1,
        inputCommit: 'abc123',
      }

      const mockAgent: AgentInfo = {
        agentId: 'agent-123',
        roleId: 'default-worker',
        status: 'ready',
        spawnedAt: Date.now(),
      }

      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })

      await executor.start(request)

      expect(mockManager.sendChat).toHaveBeenCalledWith('agent-123', 'Execute step step-1 for run test-run-1', { signal: undefined })
    })
  })

  describe('wait', () => {
    it('resolves succeeded, tagged with agentId, once the command turn completes — without waiting for the process to exit', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })
      // A keep-alive role never exits after its turn. The old exit-polling
      // implementation would have sat here until the one-hour cap; `get` is
      // left returning a live agent to prove nothing consults it any more.
      vi.mocked(mockManager.get).mockReturnValue({ ...mockAgent, status: 'open' })

      const handle = await executor.start(request)
      const completion = await handle.wait()

      expect(completion.outcome).toBe('succeeded')
      expect(completion.agentId).toBe('agent-123')
      expect(mockManager.readConversation).not.toHaveBeenCalled()
    })

    it('resolves failed with the error message when the command turn rejects', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockRejectedValue(new Error('Agent execution failed'))

      const handle = await executor.start(request)
      const completion = await handle.wait()

      expect(completion.outcome).toBe('failed')
      expect(completion.error).toContain('Agent execution failed')
      expect(completion.agentId).toBe('agent-123')
    })

    it('classifies a channel timeout as step_timeout and an abort as cancelled', async () => {
      const request: AgentExecutionRequest = { runId: 'run', stepId: 'step', attempt: 1, inputCommit: 'abc' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)

      vi.mocked(mockManager.sendChat).mockRejectedValue(new ChannelTimeoutError('agent-123', 10))
      const timedOut = await (await executor.start(request)).wait()
      expect(timedOut).toMatchObject({ outcome: 'failed', failureCode: 'step_timeout', agentId: 'agent-123' })
      expect(timedOut.error).toContain('timed out after 10 ms')

      vi.mocked(mockManager.sendChat).mockRejectedValue(new ChannelAbortedError('agent-123'))
      const aborted = await (await executor.start(request)).wait()
      expect(aborted).toMatchObject({ outcome: 'cancelled', failureCode: 'cancelled' })

      vi.mocked(mockManager.sendChat).mockRejectedValue(new Error('turn failed: provider 503'))
      const other = await (await executor.start(request)).wait()
      expect(other.outcome).toBe('failed')
      expect(other.failureCode).toBeUndefined()

      // Account quota is the environment, not the agent (claude-code's wording).
      vi.mocked(mockManager.sendChat).mockRejectedValue(new Error('Sub-agent "a" turn failed: You\'ve hit your session limit · resets 9:50am'))
      const quota = await (await executor.start(request)).wait()
      expect(quota).toMatchObject({ outcome: 'failed', failureCode: 'provider_rate_limited' })
    })

    it('passes turnTimeoutMs to sendChat, and otherwise leaves the timeout to the role', async () => {
      const request: AgentExecutionRequest = { runId: 'run', stepId: 'step', attempt: 1, inputCommit: 'abc' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })

      await (await new AgentManagerExecutor(mockManager, { turnTimeoutMs: 1234 }).start(request)).wait()
      expect(mockManager.sendChat).toHaveBeenLastCalledWith('agent-123', expect.any(String), expect.objectContaining({ timeoutMs: 1234 }))

      await (await executor.start(request)).wait()
      expect(mockManager.sendChat).toHaveBeenLastCalledWith('agent-123', expect.any(String), expect.not.objectContaining({ timeoutMs: expect.anything() }))
    })

    it('fails with a timeout and closes the agent when the turn outlives maxWaitMs', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      // The turn never completes.
      vi.mocked(mockManager.sendChat).mockReturnValue(new Promise(() => undefined))
      vi.mocked(mockManager.close).mockResolvedValue()

      vi.useFakeTimers()
      try {
        const handle = await new AgentManagerExecutor(mockManager, { maxWaitMs: 5_000 }).start(request)
        const waitPromise = handle.wait()
        await vi.advanceTimersByTimeAsync(5_001)
        const result = await waitPromise
        expect(result.outcome).toBe('failed')
        expect(result.failureCode).toBe('step_timeout')
        expect(result.error).toContain('timeout')
        expect(mockManager.close).toHaveBeenCalledWith('agent-123')
      } finally {
        vi.useRealTimers()
      }
    })

    it('defaults maxWaitMs to one hour', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockReturnValue(new Promise(() => undefined))
      vi.mocked(mockManager.close).mockResolvedValue()

      vi.useFakeTimers()
      try {
        const handle = await executor.start(request)
        const waitPromise = handle.wait()
        await vi.advanceTimersByTimeAsync(3_600_000 - 1)
        expect(mockManager.close).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2)
        expect((await waitPromise).outcome).toBe('failed')
      } finally {
        vi.useRealTimers()
      }
    })

    it('resolves cancelled and closes the agent when the request signal aborts mid-turn', async () => {
      const controller = new AbortController()
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123', signal: controller.signal }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockReturnValue(new Promise(() => undefined))
      vi.mocked(mockManager.close).mockResolvedValue()

      const handle = await executor.start(request)
      const waitPromise = handle.wait()
      controller.abort()
      const result = await waitPromise
      expect(result.outcome).toBe('cancelled')
      expect(mockManager.close).toHaveBeenCalledWith('agent-123')
    })

    it('does not let a late turn completion overwrite a timeout that already settled', async () => {
      const request: AgentExecutionRequest = { runId: 'test-run-1', stepId: 'step-1', attempt: 1, inputCommit: 'abc123' }
      const mockAgent: AgentInfo = { agentId: 'agent-123', roleId: 'default-worker', status: 'ready', spawnedAt: Date.now() }
      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      let finishTurn: () => void = () => undefined
      vi.mocked(mockManager.sendChat).mockReturnValue(new Promise((resolve) => {
        finishTurn = () => resolve({ text: 'late', durationMs: 1, toolCalls: [] })
      }))
      vi.mocked(mockManager.close).mockResolvedValue()

      vi.useFakeTimers()
      try {
        const handle = await new AgentManagerExecutor(mockManager, { maxWaitMs: 1_000 }).start(request)
        const waitPromise = handle.wait()
        await vi.advanceTimersByTimeAsync(1_001)
        const result = await waitPromise
        expect(result.outcome).toBe('failed')
        finishTurn()
        await vi.advanceTimersByTimeAsync(10)
        // Same promise, same settled value.
        expect((await handle.wait()).outcome).toBe('failed')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('cancel', () => {
    it('should close the agent when cancelled', async () => {
      const request: AgentExecutionRequest = {
        runId: 'test-run-1',
        stepId: 'step-1',
        attempt: 1,
        inputCommit: 'abc123',
      }

      const mockAgent: AgentInfo = {
        agentId: 'agent-123',
        roleId: 'default-worker',
        status: 'ready',
        spawnedAt: Date.now(),
      }

      vi.mocked(mockManager.spawn).mockResolvedValue(mockAgent)
      vi.mocked(mockManager.sendChat).mockResolvedValue({ text: 'done', durationMs: 5, toolCalls: [] })
      vi.mocked(mockManager.close).mockResolvedValue()

      const handle = await executor.start(request)

      if (handle.cancel) {
        await handle.cancel()
        expect(mockManager.close).toHaveBeenCalledWith('agent-123')
      }
    })
  })
})
