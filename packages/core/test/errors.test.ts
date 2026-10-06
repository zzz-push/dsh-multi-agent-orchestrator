import { describe, expect, it } from 'vitest'
import { createFailureRecord, FailureCode, sanitizeFailureMessage } from '../src/run/errors.js'

describe('sanitizeFailureMessage', () => {
  it('redacts api key, token, password and secret shaped fragments', () => {
    const providerKey = ['s', 'k'].join('') + '-example-placeholder'
    const message = `call failed: api_key=${providerKey} token: xyz789 password=hunter2 secret=foo`
    const sanitized = sanitizeFailureMessage(message)
    expect(sanitized).not.toContain(providerKey)
    expect(sanitized).not.toContain('xyz789')
    expect(sanitized).not.toContain('hunter2')
    expect(sanitized).toContain('[redacted]')
  })

  it('redacts provider-key style values even without a leading label', () => {
    const providerKey = ['s', 'k'].join('') + '-example-placeholder'
    const sanitized = sanitizeFailureMessage(`leaked ${providerKey} in the log line`)
    expect(sanitized).not.toContain(providerKey)
  })

  it('truncates overly long messages to 4096 chars', () => {
    const sanitized = sanitizeFailureMessage('a'.repeat(5_000))
    expect(sanitized.length).toBe(4_096)
  })

  it('leaves ordinary messages untouched', () => {
    expect(sanitizeFailureMessage('step failed: exit code 1')).toBe('step failed: exit code 1')
  })
})

describe('createFailureRecord', () => {
  it('sanitizes the message and truncates causeRef', () => {
    const record = createFailureRecord({
      code: FailureCode.ProviderAuthFailed,
      message: `auth failed, api_key=${['s', 'k'].join('')}-example-placeholder`,
      retryable: false,
      causeRef: 'x'.repeat(1_000),
      occurredAt: 1,
      runRevision: 0,
    })

    expect(record.message).not.toContain('example-placeholder')
    expect(record.causeRef).toHaveLength(512)
    expect(record.code).toBe(FailureCode.ProviderAuthFailed)
  })
})
