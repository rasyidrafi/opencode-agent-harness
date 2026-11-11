import { describe, expect, test } from "bun:test";
import { isHarnessError } from "../src/index.js";
import {
  EventCollector,
  ScriptedHarnessAdapter,
  staticToolBridge,
  userMessage,
  type ScriptedTurnPlan,
} from "../src/testing/index.js";
import {
  assertCapabilitiesShape,
  assertTurnEventContract,
  assistantText,
} from "../src/testing/index.js";

const plan: ScriptedTurnPlan = (turn) => {
  const text = turn.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  switch (text) {
    case "long":
      return { delayMs: 60_000 };
    case "approve":
      return {
        request: {
          kind: "approval",
          question: "Allow the command?",
          options: [{ id: "yes", label: "Yes" }],
        },
      };
    case "tool":
      return { toolCalls: [{ name: "lookup", input: { q: "x" } }] };
    case "fail":
      return {
        failure: {
          class: "usage_limit",
          message: "quota exceeded",
          retryable: true,
          retryAfterMs: 1_000,
        },
      };
    default:
      return { text: `echo: ${text}`, reasoning: "thinking it over" };
  }
};

async function openScripted() {
  const adapter = new ScriptedHarnessAdapter({ plan });
  const session = await adapter.openSession({ sessionId: "test", cwd: process.cwd() });
  const collector = new EventCollector();
  const collecting = collector.start(session.subscribe());
  return { adapter, session, collector, collecting };
}

describe("ScriptedHarnessAdapter", () => {
  test("declares a valid capability set", () => {
    const adapter = new ScriptedHarnessAdapter({ plan });
    assertCapabilitiesShape(adapter.getCapabilities());
  });

  test("simple turn emits contract-ordered events", async () => {
    const { session, collector, collecting } = await openScripted();
    await session.startTurn({ turnId: "t1", message: userMessage("hello") });
    await collector.waitFor((event) => event.type === "turn.terminal" && event.turn.id === "t1");
    assertTurnEventContract(collector.events, "t1");
    expect(assistantText(collector.events, "t1")).toBe("echo: hello");
    await session.close();
    await collecting;
  });

  test("interrupt settles a running turn", async () => {
    const { session, collector, collecting } = await openScripted();
    await session.startTurn({ turnId: "t1", message: userMessage("long") });
    await collector.waitFor((event) => event.type === "turn.started" && event.turn.id === "t1");
    await session.interruptTurn({ turnId: "t1" });
    const terminal = await collector.waitFor(
      (event) => event.type === "turn.terminal" && event.turn.id === "t1",
    );
    expect(terminal.type === "turn.terminal" && terminal.turn.status).toBe("interrupted");
    assertTurnEventContract(collector.events, "t1");
    await session.close();
    await collecting;
  });

  test("approval request is answered and the turn settles", async () => {
    const { session, collector, collecting } = await openScripted();
    await session.startTurn({ turnId: "t1", message: userMessage("approve") });
    const request = await collector.waitFor(
      (event) => event.type === "request.updated" && event.request.status === "pending",
    );
    expect(request.type).toBe("request.updated");
    if (request.type !== "request.updated") return;
    expect(request.request.options?.[0]?.id).toBe("yes");
    await session.respondToRequest({
      requestId: request.request.id,
      decision: "accept",
      optionId: "yes",
    });
    await collector.waitFor((event) => event.type === "turn.terminal" && event.turn.id === "t1");
    assertTurnEventContract(collector.events, "t1");
    await session.close();
    await collecting;
  });

  test("tool bridge round trip", async () => {
    const bridge = staticToolBridge(
      [{ name: "lookup", description: "Look something up", inputSchema: { type: "object" } }],
      async (call) => ({ content: [{ type: "text", text: `found ${call.input.q}` }] }),
    );
    const adapter = new ScriptedHarnessAdapter({ plan });
    const session = await adapter.openSession({
      sessionId: "test",
      cwd: process.cwd(),
      toolBridge: bridge,
    });
    const collector = new EventCollector();
    const collecting = collector.start(session.subscribe());
    await session.startTurn({ turnId: "t1", message: userMessage("tool") });
    const completed = await collector.waitFor(
      (event) => event.type === "tool.completed" && event.item.turnId === "t1",
    );
    expect(completed.type === "tool.completed" && completed.item.output).toBe("found x");
    await collector.waitFor((event) => event.type === "turn.terminal" && event.turn.id === "t1");
    assertTurnEventContract(collector.events, "t1");
    await session.close();
    await collecting;
  });

  test("failed turn reports a failure", async () => {
    const { session, collector, collecting } = await openScripted();
    await session.startTurn({ turnId: "t1", message: userMessage("fail") });
    const terminal = await collector.waitFor(
      (event) => event.type === "turn.terminal" && event.turn.id === "t1",
    );
    expect(terminal.type === "turn.terminal" && terminal.turn.status).toBe("failed");
    expect(terminal.type === "turn.terminal" && terminal.failure?.class).toBe("usage_limit");
    assertTurnEventContract(collector.events, "t1");
    await session.close();
    await collecting;
  });

  test("close rejects further turns with session_stopped", async () => {
    const { session } = await openScripted();
    await session.close();
    let caught: unknown;
    try {
      await session.startTurn({ turnId: "t2", message: userMessage("hi") });
    } catch (error) {
      caught = error;
    }
    expect(isHarnessError(caught) && caught.code).toBe("session_stopped");
  });
});
