# @dsh/agent-manager

`@dsh/agent-manager` owns child-agent processes, bidirectional harness
channels, and an append-only event journal. The journal is the only trusted
conversation source; Claude and Codex session files are never read by the
package. The manager generates `agentId` values and stores a harness-native
session id only as attached metadata.

## Quick start

```ts
import {
  AgentManager,
  ClaudeCodeChannel,
  CodexChannel,
  FileRoleProvider,
} from '@dsh/agent-manager'

const manager = new AgentManager({
  roleProvider: new FileRoleProvider({ rolesDir: '.dsh/roles' }),
  journalFile: '.dsh/runtime/agent-events.jsonl',
  channels: [new ClaudeCodeChannel(), new CodexChannel()],
})

const agent = await manager.spawn('example-role')
// Work goes through sendChat: it returns the reply, and the role's own
// declared verification rules run on it (`reply.verification`).
const reply = await manager.sendChat(agent.agentId, 'Inspect the requested task and return a short summary.')
console.log(reply.text, reply.verification?.passed)
await manager.dispose()
```

`sendChat` uses the role's `execution.chat_timeout_ms`, else the project
policy's `defaults.chatTimeoutMs`, else ten minutes; a call can pass its own
`timeoutMs`, and every call accepts an `AbortSignal`.

`sendCommand(agentId, { kind, payload, text })` is for control instructions
only: it discards the reply and does not run the role's verification, so its
resolving says the turn ended, not that anything was done right. Do not use it
to dispatch work you need to judge.

Use `readConversation({ agentId, after, roles, kinds, limit })` to page through
manager-owned events while a turn is still running. `after` is the returned
sequence cursor, never a timestamp.

## Cordis plugin

The default plugin provides the `dsh.agentManager` service and closes every
child before the Fiber is disposed:

```ts
const fiber = await ctx.plugin(DshAgentManagerPlugin, {
  rolesDir: '.dsh/roles',
  journalFile: '.dsh/runtime/agent-events.jsonl',
})
const manager = ctx.get(agentManagerService)
```

## Writing a Channel adapter

`Channel` is the public extension point. An adapter should follow this
checklist:

1. Give the harness a stable `harness` id and accurately report its
   `capabilities`.
2. In `open`, spawn the official structured transport, pass the role's system
   prompt through the harness-native option, and return a
   `ChannelSession` containing a harness-native session id. Do not use tmux,
   screen scraping, or private CLI session files.
3. Emit every observable event through `options.onEvent` as soon as it arrives:
   user/assistant `message`, `tool_call`, `tool_result`, command/chat lifecycle,
   errors, and `agent.exited`. Event observers must not be able to break the
   protocol loop.
4. Implement `sendCommand` as one structured turn and `sendChat` as one
   complete reply. `sendChat` must use
   `DEFAULT_SEND_CHAT_TIMEOUT_MS` (600,000 ms) when no timeout is supplied and
   reject promptly when its `AbortSignal` aborts.
5. Keep completion state separate from caller state. A timeout or abort may
   release the caller while a late harness event still has to be journaled.
6. Make `close` idempotent, terminate the child, and await its exit. A channel
   that leaves an orphan process violates the lifecycle contract. Spawn through
   `spawnManaged()`: its `killGraceful()` signals the whole process tree (the
   `codex` / `claude` commands on PATH are launcher scripts whose real binary is
   a grandchild), and every process it starts is tracked, so a host that calls
   `installShutdownHandlers()` takes them down on SIGINT / SIGTERM / SIGHUP
   instead of leaving them reparented to init.
7. Respect observe-only agents. An agent advertised with an `evaluation`
   context (one arm of a running `@dsh/role-eval` comparison) belongs to a
   measurement: its owner's control socket refuses forwarded chat, commands
   and close (`AgentObserveOnlyError`, code `observe-only`), the web surface
   answers 409, and the Agent dock lists it under "评估中" with the composer
   and terminate button disabled. Pages match it by
   `evaluation.workspace`, since its own cwd is a temporary worktree.
8. Claude sub-agents run on **Sonnet at medium effort** by default
   (`DEFAULT_CLAUDE_SUBAGENT_MODEL` / `DEFAULT_CLAUDE_SUBAGENT_EFFORT`, passed
   as `--model` / `--effort`). `new ClaudeCodeChannel({ model, effort })` overrides it
   (`null` = no flag, the CLI's own default); the Cordis plugin exposes the
   same as `claudeModel` / `claudeEffort`.
9. Map the harness-neutral sandbox modes. Task manifests and project policy
   speak `workspace-write` (edit and run commands inside the working
   directory, nothing outside it); `ClaudeCodeChannel` turns it into
   `--permission-mode acceptEdits` plus Claude's OS sandbox with
   `autoAllowBashIfSandboxed` and no unsandboxed escape
   (`claudeSandboxArgs()`), `CodexChannel` passes it through as codex's own
   sandbox. An unknown mode must not silently become "default mode" — for a
   headless agent that means it can neither edit nor run anything.

The adapter should depend only on `channel/types.ts`, process primitives, and
its harness protocol. It should not import Cordis or the journal writer;
`AgentManager` supplies the event sink and owns persistence. See
`ClaudeCodeChannel` first, then `CodexChannel`, for complete examples of line
framing, JSON-RPC correlation, early notification buffering, and cancellation.

Codex is locked to protocol v2. When upgrading the CLI, regenerate the source
types with `codex app-server generate-ts --out <dir>` and refresh the selected
request files under `src/channel/generated/codex/`; do not copy definitions from
the coexisting v1 schema.

## Generic TUI windows

`TuiWindowChannel` decorates any structured `Channel` with one independent
window per Agent. It preserves the wrapped harness id, delegates all protocol
traffic to the wrapped channel, and uses a `TuiLaunchSpec` only to describe the
official interactive CLI command. `TmuxTuiWindowManager` owns only the named
tmux session for that Agent: it does not send keystrokes or scrape terminal
output.

A launch spec declares when its remote UI can attach. Codex uses
`ready: 'afterFirstTurnStart'` because a new thread cannot be resumed until its
first rollout exists. The default plugin wires this generic layer for roles that
set `interaction_mode: interactive` and `show_window: true` in their YAML.
When the window backend is unavailable, the structured Agent continues
headlessly and the failure is logged.

## Harness Agent window and cross-process discovery

The Cordis plugin also serves `/plugins/dsh-agent-manager/*` and registers a
`shell.overlay` entry in the DSH web client: the Agent dock in the bottom-right
corner. The dock is **bound to the project the page is showing** — the open
session's `cwd`, or the most recent Workspace when no session is open — and
`GET /state?cwd=<project>` returns only agents whose working directory is that
project or a directory beneath it (git worktrees included). Switching sessions
re-polls immediately.

The routes (`GET /state`, `GET /conversation`, `POST /chat`, `POST /close`)
serve only the DSH page. DSH's web server does not authenticate plugin
routes, so each request is checked first and refused with 403 when another
web site could have started it: `Host` must be `localhost` or an IP address
(this stops DNS rebinding), a cross-site `Sec-Fetch-Site` or a foreign
`Origin` is refused, and a body must be sent as `application/json`. Both the
web profile and the desktop app (which forwards the page's requests from its
main process) pass these checks; so do local tools such as `curl`. There is
no route that starts an Agent.

Agents started by *other* processes on the machine are listed too, as long as
they went through `AgentManager`: every manager advertises each open child in
`$DSH_HOME/runtime/agent-manager/live-agents/<agentId>.json` (default
`~/.dsh/…`, `liveAgentRegistryDir` to override, `false` to opt out) and
withdraws it on exit, close and `dispose()`. `AgentManager.discover()` merges
its own children with those entries, probing `ownerPid` and pruning entries
whose owner is gone. External agents carry `external: true`; their history is
read from the journal named in the entry, while `/chat` and `/close` answer
`409` because the channel lives in the owner process.

## Role source

`FileRoleProvider` scans `.dsh/roles/*.yaml` and is intentionally isolated
behind `RoleProvider`. Role `execution` values are requests and must be
intersected with host policy before capabilities are granted.
