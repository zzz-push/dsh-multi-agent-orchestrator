# @dsh/comm-eventbus

进程内 EventEmitter 通讯 Provider。每次 `open(scope)` 创建独立 emitter，因此不同 Run/Attempt 的租约互不可见。

能力声明：

| 能力 | 值 |
| --- | --- |
| delivery | `at-most-once` |
| durable | `false` |
| ordering | `none` |
| requestReply | `true` |
| cancellation | `local` |
| maxMessageBytes | `1_000_000` |

## Request/reply

```ts
import { createMessage, makeResponse } from '@dsh/communication'
import { EventBusProvider } from '@dsh/comm-eventbus'

const provider = new EventBusProvider()
const port = await provider.open({ runId: 'run-001' })

port.subscribe(
  (message) => message.type === 'question',
  async (request) => {
    await port.send(makeResponse(request, { answer: 42 }, 'worker'))
  },
)

const response = await port.request(createMessage({
  runId: 'run-001',
  type: 'question',
  sender: 'kernel',
  correlationId: 'request-001',
}), { timeoutMs: 1_000 })

await port.close()
```

超时与 AbortSignal 只取消本地等待；未决请求会从 pending 表清理。`close()` 会拒绝全部未决请求并移除订阅。
