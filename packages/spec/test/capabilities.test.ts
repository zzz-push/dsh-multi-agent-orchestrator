import { describe, expect, it } from 'vitest'
import { compatible, explainCompatibility } from '../src/capabilities.js'
import type { CommunicationCapabilities, CommunicationRequirements } from '../src/capabilities.js'

// Direct unit coverage for packages/spec/src/capabilities.ts itself: the same
// logic is also exercised indirectly via packages/communication's re-exporting wrapper
// (see packages/communication/test/capability-checker.test.ts), but that path did not credit
// coverage back to this file, which is where compatible()/explainCompatibility() are actually
// defined.

const BASE: CommunicationCapabilities = {
  delivery: 'at-most-once',
  durable: false,
  ordering: 'none',
  requestReply: true,
  cancellation: 'local',
  maxMessageBytes: 1_024,
}

describe('capabilities', () => {
  it('is compatible when requirements are empty', () => {
    expect(compatible(BASE, {})).toBe(true)
    expect(explainCompatibility(BASE, {})).toEqual({ ok: true })
  })

  it.each<{ name: string; requirements: CommunicationRequirements; expectedCode: string }>([
    { name: 'delivery', requirements: { allowedDelivery: ['at-least-once'] }, expectedCode: 'DELIVERY_UNSATISFIED' },
    { name: 'durable', requirements: { durable: true }, expectedCode: 'DURABILITY_UNSATISFIED' },
    { name: 'ordering', requirements: { allowedOrdering: ['global'] }, expectedCode: 'ORDERING_UNSATISFIED' },
    { name: 'requestReply', requirements: { requestReply: true }, expectedCode: 'REQUEST_REPLY_UNSUPPORTED' },
    { name: 'cancellation', requirements: { cancellation: 'propagated' }, expectedCode: 'CANCELLATION_UNSATISFIED' },
    { name: 'maxMessageBytes', requirements: { minMessageBytes: 2_048 }, expectedCode: 'MAX_MESSAGE_BYTES_INSUFFICIENT' },
  ])('reports $expectedCode for a $name mismatch', ({ requirements, expectedCode }) => {
    const capabilities = { ...BASE, requestReply: requirements.requestReply === true ? false : BASE.requestReply }
    const result = explainCompatibility(capabilities, requirements)
    expect(compatible(capabilities, requirements)).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failures.map((failure) => failure.code)).toContain(expectedCode)
  })

  it('does not reject on an undeclared maxMessageBytes even when a minimum is required', () => {
    const capabilities = { ...BASE, maxMessageBytes: undefined }
    expect(compatible(capabilities, { minMessageBytes: 2_048 })).toBe(true)
  })

  it('accumulates every independent mismatch in field-evaluation order', () => {
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
    if (!result.ok) {
      expect(result.failures.map((failure) => failure.code)).toEqual([
        'DELIVERY_UNSATISFIED',
        'DURABILITY_UNSATISFIED',
        'ORDERING_UNSATISFIED',
        'REQUEST_REPLY_UNSUPPORTED',
        'CANCELLATION_UNSATISFIED',
        'MAX_MESSAGE_BYTES_INSUFFICIENT',
      ])
    }
  })

  it('accepts a stronger cancellation guarantee than required', () => {
    expect(compatible({ ...BASE, cancellation: 'propagated' }, { cancellation: 'local' })).toBe(true)
  })
})
