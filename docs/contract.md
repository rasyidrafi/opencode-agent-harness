# Contract

This document is the normative reference for the adapter contract. It describes
what a harness adapter must do and what a host (OpenCode) may rely on.

## Roles

```
OpenCode host
  │  openSession / startTurn / interruptTurn / respondToRequest / close
  ▼
HarnessAdapter  ── translates ──▶  external harness protocol
  │
  └─ subscribe() ──▶ normalized HarnessEvent stream
```

- The **host** owns the OpenCode session, the OpenCode message model, and the
  ids it passes in (`sessionId`, `turnId`). It renders events and executes tools.
- The **adapter** owns the harness process/connection and translates its native
  protocol into the contract. It is the only place where harness-specific
  details are allowed to appear.
- The **tool bridge** is implemented by the host and consumed by the adapter. It
  lets the harness call OpenCode's tools. See [tool-bridge.md](tool-bridge.md).

## Lifecycle

```text
adapter.getCapabilities()
  │
adapter.openSession({ sessionId, cwd, model, toolBridge })
  │
  ├─ session.subscribe()  ← subscribe before starting turns
  │
  ├─ session.startTurn({ turnId, message })
  │     └─ turn.started → message/tool/request events → turn.terminal
  │
  ├─ session.interruptTurn({ turnId })
  ├─ session.respondToRequest({ requestId, decision, optionId })
  ├─ session.steerTurn({ turnId, message })          // optional
  ├─ session.getSnapshot()                          // optional
  │
  └─ session.close()
```

A session is single-owner: one host controls it, one adapter serves it. Hosts
must not share a session across threads or processes.

## Identity

The host assigns `sessionId` and `turnId`. The adapter echoes them and must use
them as the correlation keys for every event it emits.

The adapter assigns ids for messages, tool items, and runtime requests. The host
treats those ids as opaque unique keys for rendering and correlation.

Harness-native ids are reported as `HarnessNativeRef`:

| strength | meaning |
| --- | --- |
| `strong` | Stable across process restarts. Safe to persist and resume from. |
| `weak` | Valid only while the live session/process is alive. |
| `none` | The harness does not expose this kind of id. |

The host must never use a native id as a primary key, and must not assume a
native id exists.

## Capabilities

Capabilities are returned once by `getCapabilities()` and must be stable for the
lifetime of the adapter instance. Hosts check them before using an optional
operation; they never branch on `adapter.info.id`.

| group | field | meaning |
| --- | --- | --- |
| sessions | `supportsModelSwitch` | Change models without reopening the session. |
| sessions | `supportsResume` | Resume after the host process restarts. |
| sessions | `pendingRequestsSurviveRestart` | Pending approvals/questions survive a restart. |
| sessions | `maxConcurrentTurns` | How many turns the harness runs concurrently. |
| threads | `exposesNativeThreadId` | The harness exposes a native thread/conversation id. |
| threads | `canFork` | Native forking is available. |
| threads | `canReadSnapshot` | A full conversation snapshot can be read. |
| turns | `exposesNativeTurnId` | The harness exposes a native turn id. |
| turns | `emitsTurnStarted` | `turn.started` is emitted. |
| turns | `emitsTurnCompleted` | A terminal turn status is reported. |
| turns | `supportsInterrupt` | `interruptTurn` works. |
| turns | `supportsSteering` | `steerTurn` modifies an in-flight turn. |
| turns | `supportsQueuedMessages` | Messages sent during a turn are queued by the harness. |
| turns | `terminalStatusQuality` | `strong`, `weak`, or `none`. |
| streaming | `streamsAssistantText` | Assistant text arrives as `message.delta`. |
| streaming | `streamsReasoning` | Reasoning arrives as `message.delta`. |
| streaming | `streamsToolOutput` | Tool output arrives as `tool.delta`. |
| streaming | `emitsMessageCompleted` | `message.completed` is emitted. |
| tools | `exposesToolItemIds` | The harness exposes native tool item ids. |
| tools | `emitsToolStarted` | `tool.started` is emitted. |
| tools | `emitsToolCompleted` | `tool.completed` is emitted. |
| tools | `emitsToolOutput` | Tool output is reported. |
| tools | `supportsMcpTools` | The harness can consume MCP tools from the bridge. |
| approvals | `supportsCommandApproval` | Command approvals can be requested. |
| approvals | `supportsFileReadApproval` | File-read approvals can be requested. |
| approvals | `supportsFileChangeApproval` | File-change approvals can be requested. |
| approvals | `approvalsHaveNativeRequestIds` | The harness exposes native request ids. |
| approvals | `approvalCallbacksAreLiveOnly` | Answers are only valid while the process is alive. |
| input | `acceptsText` / `acceptsImages` / `acceptsFiles` | Supported attachment kinds. |
| input | `maxAttachments` | Declared ceiling, or `null` when none is declared. |
| identity | `nativeThreadIds` / `nativeTurnIds` / `nativeItemIds` / `nativeRequestIds` | Ref strength for each kind. |

A capability that is `false` must mean the operation is unavailable. Adapters
must reject calls to optional operations they do not implement with a
`HarnessError` whose code is `unsupported`.

## Events

All events for a session arrive on the `subscribe()` stream. Every event
belongs to exactly one turn (except `session.updated` and `session.error`).

| event | payload | notes |
| --- | --- | --- |
| `session.updated` | `HarnessSessionInfo` | Status or error changed. |
| `session.error` | `HarnessFailure` | Terminal session-level failure. |
| `turn.started` | `HarnessTurn` | First event for the turn. |
| `turn.updated` | `HarnessTurn` | Intermediate status/usage. |
| `turn.terminal` | `HarnessTurn`, `HarnessFailure \| null` | Last event for the turn. |
| `message.started` | `HarnessMessage` | Message created, empty content. |
| `message.delta` | `messageId`, `text?`, `reasoning?` | Incremental text/reasoning. |
| `message.completed` | `HarnessMessage` | Final content snapshot. |
| `tool.started` | `HarnessToolItem` | Tool call began. |
| `tool.delta` | `itemId`, `chunk` | Incremental output. |
| `tool.completed` | `HarnessToolItem` | Final status and output. |
| `request.updated` | `HarnessRuntimeRequest` | Request created, resolved, expired, or cancelled. |

### Ordering guarantees

1. `turn.started` precedes every event belonging to that turn.
2. `turn.terminal` is the last event for the turn.
3. Every open message, tool item, and runtime request for the turn is settled
   before `turn.terminal`:
   - messages reach `completed` or `failed`
   - tools reach `completed`, `failed`, or `cancelled`
   - requests reach `resolved`, `expired`, or `cancelled`
4. `message.started` precedes its `message.delta` and `message.completed`.
5. `tool.started` precedes its `tool.delta` and `tool.completed`.
6. A turn that fails or is interrupted still emits `turn.terminal`.

Adapters that cannot emit `turn.started` (capability `false`) may start the
stream with message events, but they must still honor the terminal guarantee.

### Terminal statuses

| status | meaning |
| --- | --- |
| `completed` | The harness finished the turn normally. |
| `interrupted` | The host interrupted the turn. |
| `cancelled` | The harness cancelled the turn for its own reasons. |
| `failed` | The turn failed; `failure` describes why. |

## Errors

Adapters throw `HarnessError` for expected failure modes.

| code | meaning |
| --- | --- |
| `open_failed` | `openSession` failed. |
| `close_failed` | `close` failed. |
| `session_stopped` | The session is closed. |
| `protocol_error` | The harness returned something the adapter cannot interpret. |
| `unsupported` | The operation is not supported by the harness. |
| `interrupt_timeout` | The harness did not confirm the stop in time. |
| `request_failed` | The harness rejected a runtime request response. |
| `event_stream_failed` | The normalized event stream broke. |
| `usage_limit` | Quota/rate limit; may carry `retryAfterMs`. |
| `auth_required` | The harness needs authentication. |
| `invalid_input` | The host sent something invalid. |

`retryable` and `retryAfterMs` are advisory. `details` is harness-specific and
must never be parsed by the host.

## Tool bridge

`HarnessToolBridge` is implemented by the host and handed to the adapter in
`openSession` and/or `startTurn`. The latest bridge wins.

```ts
interface HarnessToolBridge {
  listTools(): Promise<HarnessToolDefinition[]> | HarnessToolDefinition[];
  callTool(call: HarnessToolCall): Promise<HarnessToolResult>;
  close?(): Promise<void> | void;
}
```

When `tools.supportsMcpTools` is `true`, the adapter must advertise the bridge's
tools to the harness and forward calls back through `callTool`. The endpoint
must be scoped to the session/turn so tools and results never cross sessions.
See [tool-bridge.md](tool-bridge.md).

## What the contract does not define

Intentionally out of scope for v1, to be added only when a second adapter needs
them:

- native thread/fork/resume operations beyond `openSession({ resumeFrom })`
- plan/todo artifacts
- subagent lifecycle
- checkpoints and rollback
- streaming resource reads
- system/context injection; adapters that need host instructions should accept
  them through an adapter-specific extension for now

Adapters may expose harness-specific extensions, but extensions must not change
the meaning of the core contract.
