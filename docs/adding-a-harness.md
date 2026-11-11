# Adding a harness

This guide walks through implementing a `HarnessAdapter` for a new external
agent harness. It assumes you have read [contract.md](contract.md).

## 1. Map the harness to the contract

Before writing code, answer these questions and encode the answers in
`getCapabilities()`:

- How does the harness open a session? What does it need (cwd, model, env)?
- What is the native turn primitive? Does it have a native turn id?
- Does it emit start/completion signals, or must you infer them?
- Can it interrupt a turn? Can it steer a running turn?
- How does it request approvals or ask questions? Does it give native request
  ids and option ids?
- How does it expose tools? Does it support MCP?
- What are its terminal statuses, and how reliable are they?
- What native ids does it expose, and are they stable across restarts?

Do not guess. Run the harness and observe it. A capability that is on but fails
at runtime is worse than a capability that is off.

## 2. Implement the adapter

```ts
import type {
  HarnessAdapter,
  HarnessSession,
  OpenSessionInput,
} from "@opencode-agent-harness/core";

export class MyHarnessAdapter implements HarnessAdapter {
  readonly info = { id: "my-harness", label: "My Harness", version: "1.0.0" };

  getCapabilities() {
    return {
      // Every flag verified against the real harness.
    };
  }

  async openSession(input: OpenSessionInput): Promise<HarnessSession> {
    // 1. Validate the input.
    // 2. Start/connect the harness process.
    // 3. Build the session and start translating its native events.
    // 4. Return the session immediately; stream events asynchronously.
    return new MyHarnessSession(this, input);
  }
}
```

### Session rules

- Emit `session.updated` when status or `lastError` changes.
- Emit `turn.started` before any message/tool/request event for that turn.
- Emit exactly one `turn.terminal` per turn, always.
- Settle every open message, tool, and request before the terminal.
- Never emit an event for a turn after its terminal.
- Stop emitting after `close()`.

### Event translation tips

- Keep a map from native turn id to host `turnId` (the host assigned it in
  `startTurn`).
- Buffer partial native output until you have a complete semantic unit; do not
  emit a tool call with half-parsed arguments.
- If the harness streams text, emit `message.started`, then `message.delta`,
  then `message.completed` with the full content.
- If the harness does not stream, emit `message.started` and
  `message.completed` with the full content. That is valid.
- Report reasoning through `message.delta` with the `reasoning` field. Do not
  mix reasoning into message content.

## 3. Wire the tool bridge

If the harness supports MCP tools:

1. Build an MCP endpoint scoped to the session/turn. The endpoint must be
   unguessable and must not be shared across sessions.
2. `tools/list` returns `bridge.listTools()`.
3. `tools/call` routes to `bridge.callTool` and returns the result content.
4. Handle cancellation: if the harness cancels the MCP request, stop waiting and
   reject pending work.
5. Handle process exit: reject all pending `callTool` waiters so the harness
   cannot hang forever.

See [tool-bridge.md](tool-bridge.md).

## 4. Map errors

Translate harness errors into `HarnessError` with a stable code. Classify quota
and rate limits as `usage_limit` with `retryAfterMs` when the harness gives a
reset time. Classify authentication failures as `auth_required`. Do not fold
everything into `protocol_error`.

## 5. Test

### Contract conformance

```ts
import { runHarnessConformance } from "@opencode-agent-harness/core/testing";

const result = await runHarnessConformance({
  adapter: myAdapter,
  driver: myDriver, // drives your harness through the shared scenarios
  toolBridge: myToolBridge,
});
```

Implement the driver so each scenario does what the name says. The suite checks
capability honesty, ordering, terminal settlement, interruption, approvals,
and the tool bridge round trip.

### Adapter tests

- Record real transcripts from the harness and replay them through the adapter
  and your projections. Hand-written protocol frames are guesses.
- Cover the terminal paths: completion, interrupt, provider failure, process
  exit.
- Test a stop sent immediately after the prompt.
- Test a tool call that is still pending when the turn is interrupted.
- Test a process restart with pending approvals if `supportsResume` is on.
- Test a symlinked workspace (macOS `/tmp`): do not compare canonical paths if
  the harness rejects them.

## Traps

These have broken multiple adapters:

- **Assuming a capability.** If `supportsInterrupt` is off, the host must not
  call `interruptTurn`. If it is on, interrupting must actually stop work.
- **Emitting after the terminal.** Once `turn.terminal` is emitted, the host
  drops the turn. Late tool output is lost.
- **Leaving items open.** A pending tool or approval at the terminal looks like
  a hung turn to the host.
- **Treating native ids as stable.** A weak id used after a restart corrupts
  state.
- **Inventing approval option ids.** Pass the harness's own ids through
  unchanged; the harness will reject unknown ids.
- **Sending a stop before the turn starts.** A cancel that reaches the harness
  before it registered the prompt can be ignored while the turn runs anyway.
  Find the harness's own turn-started signal and test that race.
- **Ignoring the tool bridge lifecycle.** Pending calls must be rejected on
  interrupt, close, and process exit. A lost call hangs the harness.
- **Assuming tools are static.** The host may change the tool set per turn;
  advertise the latest bridge, not a cached list.
- **Copying credentials or ambient env.** Two sessions must not silently share
  an account or billing context. Drop credentials the session did not configure.
- **Pretending a weak terminal is strong.** If the harness does not confirm
  completion, set `terminalStatusQuality` to `weak` or `none` and let the host
  infer.

## Checklist

- [ ] `getCapabilities()` reflects observed behavior, validated by
      `assertCapabilitiesShape`.
- [ ] Session emits `session.updated` on status changes.
- [ ] Every turn has exactly one terminal event.
- [ ] No events after the terminal.
- [ ] Open messages/tools/requests are settled before the terminal.
- [ ] Interrupt works and is tested against a long-running turn.
- [ ] Approval option ids are passed through unchanged.
- [ ] Tool bridge calls are forwarded, cancellable, and rejected on close.
- [ ] Errors use stable `HarnessError` codes; usage limits carry `retryAfterMs`.
- [ ] Conformance suite passes.
- [ ] Replay tests cover completion, interrupt, failure, and process exit.
