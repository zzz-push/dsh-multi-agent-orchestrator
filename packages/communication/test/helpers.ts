import type {
  CommunicationCapabilities,
  CommunicationMessage,
  CommunicationPort,
  CommunicationProvider,
  MessageFilter,
  MessageHandler,
  RequestOptions,
  Scope,
} from '@dsh/spec'

export const DEFAULT_CAPABILITIES: CommunicationCapabilities = {
  delivery: 'at-most-once',
  durable: false,
  ordering: 'none',
  requestReply: true,
  cancellation: 'local',
  maxMessageBytes: 1_000_000,
}

export class RecordingPort implements CommunicationPort {
  readonly sent: CommunicationMessage[] = []
  closeCalls = 0
  closeError?: Error
  private closed = false
  private readonly subscriptions = new Set<{
    filter: MessageFilter
    handler: MessageHandler
  }>()

  async send(message: CommunicationMessage): Promise<{ acceptedAt: number }> {
    this.sent.push(message)
    for (const subscription of this.subscriptions) {
      if (subscription.filter(message)) await subscription.handler(message)
    }
    return { acceptedAt: Date.now() }
  }

  async request(
    _message: CommunicationMessage,
    _options: RequestOptions,
  ): Promise<CommunicationMessage> {
    throw new Error('request not configured')
  }

  subscribe(filter: MessageFilter, handler: MessageHandler): () => void {
    const subscription = { filter, handler }
    this.subscriptions.add(subscription)
    return () => this.subscriptions.delete(subscription)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    if (this.closed) return
    this.closed = true
    if (this.closeError) throw this.closeError
  }
}

export class FakeProvider implements CommunicationProvider {
  readonly openedScopes: Scope[] = []
  readonly openedPorts: RecordingPort[] = []
  openBehavior: 'resolve' | 'throw' | 'hang' = 'resolve'

  constructor(
    readonly name = 'fake',
    readonly version = '1.0.0',
    readonly capabilities: CommunicationCapabilities = DEFAULT_CAPABILITIES,
  ) {}

  async open(scope: Scope): Promise<CommunicationPort> {
    this.openedScopes.push(scope)
    if (this.openBehavior === 'throw') throw new Error('injected open failure')
    if (this.openBehavior === 'hang') {
      return new Promise<CommunicationPort>(() => undefined)
    }
    const port = new RecordingPort()
    this.openedPorts.push(port)
    return port
  }
}
