# @dsh/spec

通讯层的稳定类型边界，不依赖 Harness 或具体 Provider。

主要导出：

- `CommunicationMessage`
- `CommunicationProvider` / `CommunicationPort`
- `CommunicationRegistry` / `CommunicationLease`
- `CommunicationCapabilities` / `CommunicationRequirements`
- `compatible()` / `explainCompatibility()`
- `DshError`

```ts
import type {
  CommunicationCapabilities,
  CommunicationRequirements,
} from '@dsh/spec'
import { explainCompatibility } from '@dsh/spec'

const capabilities: CommunicationCapabilities = {
  delivery: 'at-most-once',
  durable: false,
  ordering: 'none',
  requestReply: true,
  cancellation: 'local',
}
const requirements: CommunicationRequirements = { requestReply: true }

const result = explainCompatibility(capabilities, requirements)
```
