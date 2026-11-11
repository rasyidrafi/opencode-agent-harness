# opencode-agent-harness

A harness-agnostic adapter contract for running external agent harnesses inside
OpenCode.

This repository does **not** contain a harness integration. It defines the small
shared contract that every integration implements, plus the conformance tooling
that proves an implementation honors it. The first consumer is
[`opencode-muse`](../opencode-muse); a future Antigravity rewrite is expected to
implement the same contract.

## Why

OpenCode talks to providers over many different protocols. An external harness
(Muse Code, Antigravity, Claude, Codex, ...) speaks its own protocol, has its own
session model, and exposes tools differently. Without a shared contract, every
OpenCode plugin reimplements the same translation, tool bridge, approval flow,
and error handling, and each one breaks in its own way.

The contract here is deliberately smaller than a full orchestration system. It
covers only what OpenCode needs to run a harness as an agent:

- open and close a harness session
- start a turn and receive a normalized event stream
- interrupt a turn, steer it when the harness supports it
- report capabilities honestly, including what the harness cannot do
- surface approvals and questions as runtime requests
- expose OpenCode's tools to the harness through a tool bridge

## Layout

```
src/                 The contract package (@opencode-agent-harness/core)
  adapter.ts         HarnessAdapter / HarnessSession interfaces
  capabilities.ts    Capability groups; hosts gate optional behavior on these
  entities.ts        Session, turn, message, tool item, request, failure
  events.ts          Normalized event stream and ordering guarantees
  tool-bridge.ts     OpenCode -> harness tool bridge
  ids.ts             Native reference model (strong / weak / none)
  errors.ts          Typed HarnessError codes
src/testing/         Conformance suite, assertions, scripted reference adapter
test/                Unit and conformance tests for the contract itself
docs/                Contract reference and integration guides
```

## Install

```bash
bun add @opencode-agent-harness/core
```

The package is plain TypeScript with no runtime dependencies. It runs on Bun and
Node >= 22.

## Implement an adapter

```ts
import type { HarnessAdapter, HarnessSession } from "@opencode-agent-harness/core";

export const museAdapter: HarnessAdapter = {
  info: { id: "muse", label: "Muse Code", version: "1.4.15" },
  getCapabilities() {
    return {
      // ... every flag reflects what Muse actually does
    };
  },
  async openSession(input) {
    // Spawn / connect to Muse, wire the tool bridge, return a HarnessSession
    return new MuseSession(input);
  },
};
```

See [`docs/adding-a-harness.md`](docs/adding-a-harness.md) for the full checklist
and the traps that have broken other adapters.

## Verify an adapter

```ts
import { runHarnessConformance } from "@opencode-agent-harness/core/testing";

const result = await runHarnessConformance({
  adapter: museAdapter,
  driver: museConformanceDriver, // harness-specific glue
  toolBridge: openCodeToolBridge,
});
if (!result.success) console.error(result.checks);
```

The suite checks capability honesty, event ordering, terminal settlement,
interruption, approvals, and the tool bridge round trip. It is a floor, not a
substitute for replay tests against the real harness.

## Design rules

1. **Capabilities are honest.** A flag left on that fails at runtime is a bug.
2. **Events are normalized.** The host never sees harness protocol details.
3. **The host owns session and turn ids.** Harness ids are opaque native refs.
4. **Optional operations are gated by capabilities**, never by adapter id.
5. **Terminal is terminal.** No event for a turn is emitted after its
   `turn.terminal`, and every open message, tool, and request is settled first.

## Status

Early. The contract is being proven against Muse Code first; generalization will
follow once a second harness implements it. Expect breaking changes before 1.0.
