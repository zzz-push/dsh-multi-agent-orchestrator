/** Provider delivery guarantees. */
export type DeliverySemantics = 'best-effort' | 'at-most-once' | 'at-least-once'

/** Provider ordering guarantees. */
export type OrderingSemantics = 'none' | 'per-key' | 'global'

/** Provider cancellation guarantees. */
export type CancellationSemantics = 'local' | 'propagated'

/** Capabilities a communication provider promises to uphold. */
export interface CommunicationCapabilities {
  /** Delivery guarantee. */
  delivery: DeliverySemantics
  /** Whether messages survive process restarts. */
  durable: boolean
  /** Ordering guarantee. */
  ordering: OrderingSemantics
  /** Whether request/reply is supported. */
  requestReply: boolean
  /** Cancellation guarantee. */
  cancellation: CancellationSemantics
  /** Maximum message size in bytes, when bounded and declared. */
  maxMessageBytes?: number
}

/** Minimum capabilities a workflow requires from a provider. */
export interface CommunicationRequirements {
  /** Accepted delivery semantics. */
  allowedDelivery?: readonly DeliverySemantics[]
  /** Requires durable delivery. */
  durable?: boolean
  /** Accepted ordering semantics. */
  allowedOrdering?: readonly OrderingSemantics[]
  /** Requires request/reply support. */
  requestReply?: boolean
  /** Minimum cancellation guarantee. */
  cancellation?: CancellationSemantics
  /** Minimum message capacity in bytes. */
  minMessageBytes?: number
}

/** Stable codes returned by a capability preflight check. */
export type CapabilityFailureCode =
  | 'DELIVERY_UNSATISFIED'
  | 'DURABILITY_UNSATISFIED'
  | 'ORDERING_UNSATISFIED'
  | 'REQUEST_REPLY_UNSUPPORTED'
  | 'CANCELLATION_UNSATISFIED'
  | 'MAX_MESSAGE_BYTES_INSUFFICIENT'

/** One explainable incompatibility between requirements and capabilities. */
export interface CapabilityFailure {
  code: CapabilityFailureCode
  message: string
}

/** Result of a detailed capability check. */
export type CompatibilityResult =
  | { ok: true }
  | { ok: false; failures: CapabilityFailure[] }

/** Checks whether a provider satisfies all declared requirements. */
export function compatible(
  capabilities: CommunicationCapabilities,
  requirements: CommunicationRequirements,
): boolean {
  return explainCompatibility(capabilities, requirements).ok
}

/** Returns every capability mismatch, preserving field evaluation order. */
export function explainCompatibility(
  capabilities: CommunicationCapabilities,
  requirements: CommunicationRequirements,
): CompatibilityResult {
  const failures: CapabilityFailure[] = []

  if (requirements.allowedDelivery
    && !requirements.allowedDelivery.includes(capabilities.delivery)) {
    failures.push({
      code: 'DELIVERY_UNSATISFIED',
      message: `要求 delivery ∈ [${requirements.allowedDelivery.join(', ')}]，Provider 声明 ${capabilities.delivery}`,
    })
  }

  if (requirements.durable === true && !capabilities.durable) {
    failures.push({
      code: 'DURABILITY_UNSATISFIED',
      message: '要求 durable=true，Provider 声明 durable=false',
    })
  }

  if (requirements.allowedOrdering
    && !requirements.allowedOrdering.includes(capabilities.ordering)) {
    failures.push({
      code: 'ORDERING_UNSATISFIED',
      message: `要求 ordering ∈ [${requirements.allowedOrdering.join(', ')}]，Provider 声明 ${capabilities.ordering}`,
    })
  }

  if (requirements.requestReply === true && !capabilities.requestReply) {
    failures.push({
      code: 'REQUEST_REPLY_UNSUPPORTED',
      message: '要求支持 request/reply',
    })
  }

  if (requirements.cancellation === 'propagated'
    && capabilities.cancellation !== 'propagated') {
    failures.push({
      code: 'CANCELLATION_UNSATISFIED',
      message: `要求 cancellation=propagated，Provider 声明 ${capabilities.cancellation}`,
    })
  }

  if (requirements.minMessageBytes !== undefined
    && capabilities.maxMessageBytes !== undefined
    && capabilities.maxMessageBytes < requirements.minMessageBytes) {
    failures.push({
      code: 'MAX_MESSAGE_BYTES_INSUFFICIENT',
      message: `要求单条消息 ≥ ${requirements.minMessageBytes}B，Provider 上限 ${capabilities.maxMessageBytes}B`,
    })
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}
