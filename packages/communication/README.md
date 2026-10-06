# @dsh/communication

提供通讯 Provider 的注册、能力预检、generation 固定、租约释放与 draining。该包不依赖 Harness，也不包含具体 Provider。

## Registry

```ts
import { CommunicationRegistryImpl } from '@dsh/communication'
import { EventBusProvider } from '@dsh/comm-eventbus'

const registry = new CommunicationRegistryImpl({
  openTimeoutMs: 10_000,
  drainTimeoutMs: 60_000,
  onLeaseForced: (event) => {
    console.error(`run ${event.runId} interrupted`)
  },
})

const unregister = registry.register(new EventBusProvider())
const lease = await registry.acquire({
  provider: 'event-emitter',
  requirements: { requestReply: true },
  runId: 'run-001',
})

await lease.release()
unregister()
await registry.whenDrained(lease.generation)
```

注册同名 Provider 会创建新 generation，旧 generation 停止接收新租约，但活动租约可继续使用到释放或排空超时。`release()`、注销函数和 `dispose()` 都是幂等操作。

## 消息助手

`createMessage()` 创建协议 v1 信封，`makeResponse()` 保留请求的 scope、correlationId 和 causationId，`isResponse()` 识别保留响应类型 `dsh.comm.response`。
