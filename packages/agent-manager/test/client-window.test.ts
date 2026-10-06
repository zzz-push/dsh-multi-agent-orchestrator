// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentWindowSurface } from '../src/client/index.js'
import { PERSISTED_WINDOWS_KEY } from '../src/client/conversation.js'

const agent = {
  agentId: 'agent-1',
  roleId: 'example-builder',
  harness: 'claude-code',
  harnessSessionId: 's',
  cwd: '/repo',
  keepAliveAfterTask: true,
  interactionMode: 'headless',
  showWindow: false,
  windowHandle: null,
  status: 'open',
  external: false,
  ownerPid: 1,
}

type Json = Record<string, unknown>
let requests: string[] = []

function installFetch(pages: Record<string, Json>): void {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.includes('/state')) return reply({ project: null, agents: [agent], roles: [{ roleId: 'example-builder', name: '构建示例角色', harness: 'claude-code', keepAliveAfterTask: true }] })
    if (url.includes('/conversation')) {
      const after = new URL(url, 'http://x').searchParams.get('after') ?? ''
      return reply(pages[after] ?? { items: [], cursor: after === '' ? null : after, nextCursor: null })
    }
    return reply({ ok: true })
  }))
}

async function openWindow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Open Agent windows/ }))
  fireEvent.doubleClick(await screen.findByRole('button', { name: /^Open / }))
}

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Agent window', () => {
  it('reads the conversation incrementally, pairs tool calls with results, renders replies as Markdown, and shows what the agent is doing', async () => {
    const now = Date.now()
    installFetch({
      '': {
        items: [{ seq: 1, timestamp: now - 5_000, kind: 'message', role: 'user', payload: { text: 'fix the flaky test' } }],
        cursor: '1',
        nextCursor: '1',
      },
      '1': {
        items: [
          { seq: 2, timestamp: now - 4_000, kind: 'tool_call', role: 'assistant', payload: { toolUseId: 't1', name: 'Bash', input: { command: 'pnpm test' } } },
          { seq: 3, timestamp: now - 3_000, kind: 'tool_result', role: 'user', payload: { toolUseId: 't1', isError: false, content: 'Tests 12 passed' } },
          { seq: 4, timestamp: now - 2_000, kind: 'message', role: 'assistant', payload: { text: 'Fixed **two** tests:\n\n- `a.test.ts`' } },
          { seq: 5, timestamp: now - 1_000, kind: 'agent.activity', role: 'system', payload: { activity: 'thinking', phase: 'progress', tokens: 640 } },
        ],
        cursor: '5',
        nextCursor: null,
      },
    })
    render(React.createElement(AgentWindowSurface, {}))
    await openWindow()

    expect(await screen.findByText('fix the flaky test')).toBeTruthy()
    expect(await screen.findByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('Tests 12 passed')).toBeTruthy()
    // The reply is Markdown; what the user typed is shown as typed.
    expect((await screen.findByText('two')).tagName).toBe('STRONG')
    expect(screen.getByText('a.test.ts').tagName).toBe('CODE')
    expect(await screen.findByText('正在思考…（约 640 tokens）')).toBeTruthy()
    // First read from the start, then only what came after the cursor.
    const conversationReads = requests.filter((request) => request.includes('/conversation'))
    expect(conversationReads[0]).toBe('GET /plugins/dsh-agent-manager/conversation?agentId=agent-1')
    expect(conversationReads[1]).toBe('GET /plugins/dsh-agent-manager/conversation?agentId=agent-1&after=1')
  })

  it('keeps an unsent draft and the window placement across a page reload', async () => {
    installFetch({})
    const first = render(React.createElement(AgentWindowSurface, {}))
    await openWindow()
    const input = await screen.findByRole('textbox', { name: /Message/ })
    fireEvent.change(input, { target: { value: 'half-written thought' } })
    await waitFor(() => expect(window.localStorage.getItem(PERSISTED_WINDOWS_KEY)).toContain('half-written thought'))
    const saved = JSON.parse(window.localStorage.getItem(PERSISTED_WINDOWS_KEY)!) as { geometries: Record<string, unknown> }
    expect(saved.geometries['agent-1']).toBeDefined()
    first.unmount()

    // "Reload": a fresh component reading the same browser storage.
    render(React.createElement(AgentWindowSurface, {}))
    await openWindow()
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Message/ }) as HTMLTextAreaElement).value).toBe('half-written thought'))
  })

  it('sends a message and clears the draft', async () => {
    installFetch({})
    render(React.createElement(AgentWindowSurface, {}))
    await openWindow()
    const input = await screen.findByRole('textbox', { name: /Message/ })
    fireEvent.change(input, { target: { value: 'please continue' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    })
    await waitFor(() => expect(requests).toContain('POST /plugins/dsh-agent-manager/chat'))
    await waitFor(() => expect((screen.getByRole('textbox', { name: /Message/ }) as HTMLTextAreaElement).value).toBe(''))
  })

  it('sends on Enter, but not on Shift+Enter or the Enter that confirms an input-method candidate', async () => {
    installFetch({})
    render(React.createElement(AgentWindowSurface, {}))
    await openWindow()
    const input = await screen.findByRole('textbox', { name: /Message/ })
    fireEvent.change(input, { target: { value: '你好' } })
    const chats = (): number => requests.filter((request) => request === 'POST /plugins/dsh-agent-manager/chat').length

    // Each of these is left to the textarea (a newline, or the IME's own use).
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(true)
    expect(chats()).toBe(0)

    await act(async () => {
      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    })
    await waitFor(() => expect(chats()).toBe(1))
  })
})
