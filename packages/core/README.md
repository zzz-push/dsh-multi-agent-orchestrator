# @dsh/core

`@dsh/core` 是 DSH 的执行引擎核心，位于 `dsh-core` 分层，负责维护
RunAggregate 状态机并按批次调度 step。它只依赖核心端口和仓储抽象，不依赖
Harness 或 Cordis；上层可以通过端口接入具体执行环境。

## 核心概念

- **RunStatus / StepStatus 状态机**：Run 和 step 的每次状态变化都必须经过显式
  transition，非法跳转会被拒绝。一个 step 的执行记录、验证证据和合并结果都保存在
  RunAggregate 中。
- **RunRepository**：以 `revision` 提供 compare-and-swap（CAS）语义。更新时调用方
  必须提交预期 revision，冲突就重读并重试。提供两个实现：`FileRunRepository`
  （每 Run 一个 JSON 文档，原子写入，进程内按 runId 串行化 CAS，跨进程重启可读回；
  `@dsh/orchestrator` 默认使用）和 `InMemoryRunRepository`（只适合测试与单进程演示）。
  两者跑同一份契约测试（`test/repository-contract.ts`）。
- **Scheduler**：一次只取得一个 run 的进程内调度权，按 workflow 与全局并发上限选择
  batch。`stop_after_batch` 会让当前批次的其他独立 step 继续完成，但观察到失败后不再
  创建下一批。取消先以幂等方式写入 `cancelling` 意图，再由 Scheduler 收敛到
  `cancelled`。

## 端口

以下端口隔离了执行引擎与外部副作用。本任务范围内它们都没有真实实现，只有测试中使用
的 fake driver：

- `AgentExecutor`：启动一个 step 的 Agent 执行并等待 `AgentCompletion`。
- `WorkspaceDriver`：创建 attempt workspace，并可捕获结果、合并结果或清理 workspace。
- `VerificationDriver`：在 attempt workspace 中运行检查并返回证据。
- `Clock`：提供可替换的当前时间，便于 deadline 和状态测试。

## 真实驱动接入点

这些端口由后续适配层接入真实能力：

- 真实 `WorkspaceDriver`：由 Git worktree workspace 适配层负责创建、捕获、合并和清理。
- 真实 `AgentExecutor`：由桥接 `@dsh/agent-manager` 的执行适配层负责启动和回收 Agent。
- 真实 `VerificationDriver`：由 check 命令执行适配层负责运行检查并整理证据。

## 已知边界

- `FileRunRepository` 不做跨进程互斥；多个 Scheduler 进程共享同一目录时需要仓库级租约。
- Scheduler 的单 run 调度权只在进程内生效。
- 取消是否回收真实资源取决于接入的驱动实现。

这些边界应由宿主项目结合部署方式记录和验证。
