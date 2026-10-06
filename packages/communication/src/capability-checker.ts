import {
  compatible,
  explainCompatibility,
} from '@dsh/spec'
import type {
  CapabilityFailure,
  CommunicationRequirements,
} from '@dsh/spec'

/** Provider-scoped incompatibility details used by aggregate preflight errors. */
export interface ProviderCompatibilityFailure {
  name: string
  version: string
  failures: CapabilityFailure[]
}

/** Formats a preflight failure for an explicitly selected provider. */
export function buildPreflightMessage(
  provider: { name: string; version: string },
  failures: readonly CapabilityFailure[],
): string {
  return [
    `Provider "${provider.name}@${provider.version}" 不满足通讯要求：`,
    ...failures.map((failure) => `  - [${failure.code}] ${failure.message}`),
  ].join('\n')
}

/** Formats an aggregate preflight failure for deterministic provider selection. */
export function buildNoMatchMessage(
  requirements: CommunicationRequirements,
  byProvider: readonly ProviderCompatibilityFailure[],
): string {
  const lines = byProvider.map((provider) => {
    const failures = provider.failures.length > 0
      ? provider.failures.map((failure) => failure.code).join(', ')
      : 'UNKNOWN'
    return `  - ${provider.name}@${provider.version}: ${failures}`
  })

  if (lines.length === 0) {
    lines.push('  - 未注册任何 active Provider')
  }

  return [
    `没有 Provider 满足 requirements（${JSON.stringify(requirements)}）：`,
    ...lines,
  ].join('\n')
}

export { compatible, explainCompatibility }
export type {
  CapabilityFailure,
  CapabilityFailureCode,
  CommunicationCapabilities,
  CommunicationRequirements,
  CompatibilityResult,
} from '@dsh/spec'
