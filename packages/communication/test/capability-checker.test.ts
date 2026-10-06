import { describe, expect, it } from 'vitest'
import type {
  CommunicationCapabilities,
  CommunicationRequirements,
} from '@dsh/spec'
import {
  buildNoMatchMessage,
  buildPreflightMessage,
  compatible,
  explainCompatibility,
} from '../src/capability-checker.js'

const BASE: CommunicationCapabilities = {
  delivery: 'at-most-once',
  durable: false,
  ordering: 'none',
  requestReply: true,
  cancellation: 'local',
  maxMessageBytes: 1_024,
}

describe('capability checker', () => {
  it.each<{
    name: string
    capabilities: CommunicationCapabilities
    requirements: CommunicationRequirements
    expectedCode?: string
  }>([
    { name: 'empty requirements', capabilities: BASE, requirements: {} },
    {
      name: 'durability mismatch',
      capabilities: BASE,
      requirements: { durable: true },
      expectedCode: 'DURABILITY_UNSATISFIED',
    },
    {
      name: 'delivery mismatch',
      capabilities: BASE,
      requirements: { allowedDelivery: ['at-least-once'] },
      expectedCode: 'DELIVERY_UNSATISFIED',
    },
    {
      name: 'one allowed delivery matches',
      capabilities: { ...BASE, delivery: 'at-least-once' },
      requirements: { allowedDelivery: ['at-least-once', 'at-most-once'] },
    },
    {
      name: 'request reply mismatch',
      capabilities: { ...BASE, requestReply: false },
      requirements: { requestReply: true },
      expectedCode: 'REQUEST_REPLY_UNSUPPORTED',
    },
    {
      name: 'propagated cancellation required',
      capabilities: BASE,
      requirements: { cancellation: 'propagated' },
      expectedCode: 'CANCELLATION_UNSATISFIED',
    },
    {
      name: 'propagated cancellation matches',
      capabilities: { ...BASE, cancellation: 'propagated' },
      requirements: { cancellation: 'propagated' },
    },
    {
      name: 'local cancellation accepts propagated',
      capabilities: { ...BASE, cancellation: 'propagated' },
      requirements: { cancellation: 'local' },
    },
    {
      name: 'ordering is not promoted implicitly',
      capabilities: { ...BASE, ordering: 'global' },
      requirements: { allowedOrdering: ['per-key'] },
      expectedCode: 'ORDERING_UNSATISFIED',
    },
    {
      name: 'message size too small',
      capabilities: BASE,
      requirements: { minMessageBytes: 2_048 },
      expectedCode: 'MAX_MESSAGE_BYTES_INSUFFICIENT',
    },
    {
      name: 'undeclared size does not reject',
      capabilities: { ...BASE, maxMessageBytes: undefined },
      requirements: { minMessageBytes: 2_048 },
    },
  ])('$name', ({ capabilities, requirements, expectedCode }) => {
    const result = explainCompatibility(capabilities, requirements)
    expect(compatible(capabilities, requirements)).toBe(expectedCode === undefined)
    if (expectedCode === undefined) {
      expect(result).toEqual({ ok: true })
    } else {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failures[0]?.code).toBe(expectedCode)
    }
  })

  it('returns every independent mismatch', () => {
    const result = explainCompatibility(
      { ...BASE, requestReply: false },
      {
        allowedDelivery: ['at-least-once'],
        durable: true,
        allowedOrdering: ['global'],
        requestReply: true,
        cancellation: 'propagated',
        minMessageBytes: 2_048,
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failures).toHaveLength(6)
  })

  it('formats named and aggregate preflight messages', () => {
    const failure = {
      code: 'DURABILITY_UNSATISFIED' as const,
      message: 'durable required',
    }
    expect(buildPreflightMessage({ name: 'event', version: '1' }, [failure]))
      .toContain('[DURABILITY_UNSATISFIED]')
    expect(buildNoMatchMessage(
      { durable: true },
      [{ name: 'event', version: '1', failures: [failure] }],
    )).toContain('event@1: DURABILITY_UNSATISFIED')
    expect(buildNoMatchMessage({}, [])).toContain('未注册任何 active Provider')
  })
})
