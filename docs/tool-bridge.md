# Tool bridge

The tool bridge is how OpenCode's own tools become available to an external
harness. Without it, the harness can only use tools it implements itself; with
it, the harness can call OpenCode's tools and receive their results.

## Flow

```text
OpenCode session
  │  startTurn({ turnId, message, toolBridge })
  ▼
HarnessAdapter
  │  expose bridge.listTools() as MCP tools
  ▼
External harness
  │  tools/call { name, arguments }
  ▼
Adapter's MCP endpoint
  │  bridge.callTool({ id, name, input })
  ▼
OpenCode executes the tool
  │  HarnessToolResult { content, isError }
  ▼
Adapter → harness → model continues
```

## Who does what

### Host (OpenCode plugin)

- Implements `HarnessToolBridge`.
- `listTools()` returns the tool definitions OpenCode wants the harness to see.
- `callTool()` executes the tool and returns content blocks.
- May change the tool set per turn; the latest bridge wins.
- Must not execute tools for a session/turn that has ended.

### Adapter

- Advertises the bridge's tools to the harness through the harness's native
  mechanism (usually MCP).
- Forwards `tools/call` to `bridge.callTool` unchanged.
- Maps the result content blocks back to the harness's tool-result format.
- Scopes the endpoint to one session or turn. Never share an endpoint across
  sessions.
- Rejects pending calls on interrupt, close, and process exit.

## MCP mapping

When `tools.supportsMcpTools` is `true`, the adapter exposes an MCP server:

| MCP method | adapter behavior |
| --- | --- |
| `initialize` | Negotiate protocol version; advertise the `tools` capability. |
| `tools/list` | Return `bridge.listTools()` with JSON Schema `inputSchema`. |
| `tools/call` | Forward to `bridge.callTool`; return `content` and `isError`. |
| `notifications/cancelled` | Cancel the pending call and stop waiting. |

`HarnessToolResult.content` uses MCP-compatible blocks:

```ts
type HarnessToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }   // base64
  | { type: "file"; mediaType: string; data: string; name?: string };
```

## Lifecycle

1. The host supplies a bridge to `openSession` and/or `startTurn`.
2. The adapter reads `listTools()` when the harness asks (lazily) or when the
   turn starts. Lazy is safer: the tool set can change per turn.
3. The adapter forwards calls as they arrive.
4. When the session/turn ends, the adapter calls `bridge.close()` if present
   and rejects all pending calls.

## Failure handling

- **Unknown tool**: return an `isError` result with a text block. Do not crash.
- **Invalid arguments**: return an `isError` result. The model can correct.
- **Host execution fails**: return `isError: true` with the error message. Do
  not throw across the MCP boundary.
- **Host execution hangs**: apply a timeout if the harness has one; otherwise
  keep the call pending and make sure cancellation is honored.
- **Interrupt/close**: reject pending calls so the harness can settle the turn.
- **Process exit**: reject all pending calls. A lost call must never hang the
  harness.

## Traps

- **Caching the tool list.** If the host changes tools per turn, a cached list
  exposes stale tools and hides new ones.
- **Cross-session leakage.** One endpoint shared by two sessions lets one
  session call another's tools. Always scope the endpoint.
- **Blocking the event loop.** Tool execution can be slow; never block the
  adapter's event loop while waiting.
- **Reporting success without a result.** A call that never returned is not a
  success. Reject it on interrupt or exit.
- **Ignoring cancellation.** The harness may cancel a call; the host must stop
  waiting and must not deliver the result later as if it were fresh.
- **Executing tools after the turn ended.** The host must not execute tools for
  a settled turn; the adapter should reject the call.
