#!/usr/bin/env node
import readline from 'node:readline'

const mode = process.argv[2]
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const textFromClaude = (record) => {
  const content = record?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item && item.type === 'text')
    .map((item) => String(item.text ?? ''))
    .join(' ')
}

if (mode === 'claude') {
  output({ type: 'system', subtype: 'init', session_id: 'fake-claude-session' })
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      process.stdout.write('not-json\n')
      return
    }
    const text = textFromClaude(record)
    if (text.includes('EXIT')) {
      setImmediate(() => process.exit(17))
      return
    }
    if (text.includes('WAIT')) return
    const messageId = `msg-${Date.now()}`
    const model = 'fake-claude-model'
    if (text.includes('THINK')) {
      // What the real CLI streams while the model thinks, and when a request is retried.
      for (let n = 1; n <= 5; n += 1) output({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n * 100, estimated_tokens_delta: 100 })
      output({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded', no_response: { waited_ms: 120000, retry_wait_ms: 500 } })
    }
    if (text.includes('TOOL')) {
      output({ type: 'assistant', message: {
        model,
        id: messageId,
        content: [{ type: 'tool_use', id: 'tool-1', name: 'FakeTool', input: { value: 1 } }],
      } })
      output({ type: 'user', message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
      } })
    }
    const answer = text.includes('SHOW_PROMPT')
      ? `prompt:${process.argv.slice(3).join(' ')}`
      : `claude:${text}`
    output({ type: 'assistant', message: {
      model,
      id: messageId,
      content: [{ type: 'text', text: answer }],
    } })
    output({ type: 'result', is_error: false, result: answer, stop_reason: 'end_turn' })
  })
  rl.on('close', () => process.exit(0))
} else if (mode === 'codex') {
  let turnNumber = 0
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      process.stdout.write('not-json\n')
      return
    }
    if (request.method === 'initialize') {
      output({ id: request.id, result: { userAgent: 'fake-codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'test' } })
      return
    }
    if (request.method === 'thread/start') {
      const mcp = request.params?.config?.mcp_servers
      // Like codex: report the MCP servers it starts, one of them undeclared,
      // and the launch flags it was given.
      if (mcp !== undefined) {
        output({ method: 'mcpServer/startupStatus/updated', params: { name: 'leaky-plugin-server', status: 'ready' } })
        output({ method: 'mcpServer/startupStatus/updated', params: { name: 'leaky-plugin-server', status: 'ready' } })
        output({ method: 'mcpServer/startupStatus/updated', params: { name: 'example-mcp', status: 'ready' } })
      }
      output({ id: request.id, result: {
        thread: { id: 'fake-thread-1' },
        model: mcp !== undefined
          ? `fake-codex-mcp:${Object.entries(mcp).map(([name, entry]) => entry.enabled === false ? `-${name}` : name).join(',')}|${process.argv.slice(3).join(' ')}`
          : request.params?.developerInstructions ? 'fake-codex-with-prompt' : 'fake-codex-model',
      } })
      return
    }
    if (request.method === 'turn/start') {
      turnNumber += 1
      const turnId = `fake-turn-${turnNumber}`
      const text = request.params?.input?.[0]?.text ?? ''
      if (String(text).includes('WAIT_START')) {
        setTimeout(() => output({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }), 100)
        return
      }
      output({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
      if (String(text).includes('WAIT')) return
      const itemId = `item-${turnNumber}`
      if (String(text).includes('THINK')) {
        output({ method: 'item/started', params: { turnId, item: { type: 'reasoning', id: `reasoning-${turnNumber}` } } })
        output({ method: 'error', params: { turnId, threadId: 'fake-thread-1', willRetry: true, error: { message: 'stream disconnected before completion', codexErrorInfo: null, additionalDetails: null } } })
        output({ method: 'error', params: { turnId, threadId: 'fake-thread-1', willRetry: false, error: { message: 'final', codexErrorInfo: null, additionalDetails: null } } })
        output({ method: 'item/completed', params: { turnId, item: { type: 'reasoning', id: `reasoning-${turnNumber}` } } })
      }
      if (String(text).includes('TOOL')) {
        output({ method: 'item/started', params: {
          turnId,
          item: { type: 'commandExecution', id: 'codex-tool-1', command: 'printf ok' },
        } })
        output({ method: 'item/completed', params: {
          turnId,
          item: { type: 'commandExecution', id: 'codex-tool-1', command: 'printf ok', aggregatedOutput: 'ok', exitCode: 0 },
        } })
      }
      const answer = `codex:${text}`
      output({ method: 'item/completed', params: {
        turnId,
        item: { type: 'agentMessage', id: itemId, text: answer, phase: 'final_answer' },
      } })
      output({ method: 'turn/completed', params: {
        turn: { id: turnId, status: 'completed', durationMs: 3, items: [
          { type: 'agentMessage', id: itemId, text: answer, phase: 'final_answer' },
        ] },
      } })
      return
    }
    if (request.method === 'turn/interrupt') {
      output({ method: 'turn/completed', params: {
        turn: { id: request.params?.turnId, status: 'interrupted', error: { message: 'interrupted' }, items: [] },
      } })
    }
  })
  rl.on('close', () => process.exit(0))
} else {
  process.stderr.write(`unknown fake harness mode: ${String(mode)}\n`)
  process.exit(2)
}
