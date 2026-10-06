import type { CommunicationMessage } from '@dsh/spec'

let messageCounter = 0

export function makeMessage(
  partial: Partial<CommunicationMessage> = {},
): CommunicationMessage {
  messageCounter += 1
  return {
    schemaVersion: 1,
    messageId: `message-${messageCounter}`,
    runId: 'input-run',
    type: 'test.message',
    sender: 'test-sender',
    createdAt: Date.now(),
    payload: null,
    ...partial,
  }
}
