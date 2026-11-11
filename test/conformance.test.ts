import { describe, expect, test } from "bun:test";
import { disabledCapabilities, type HarnessCapabilities, type HarnessSession } from "../src/index.js";
import {
  ScriptedHarnessAdapter,
  runHarnessConformance,
  scriptedConformanceDriver,
  staticToolBridge,
  userMessage,
  type HarnessConformanceDriver,
  type ScriptedTurnPlan,
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
          options: [{ id: "yes", label: "Yes" }],
        },
      };
    case "tool":
      return { toolCalls: [{ name: "lookup", input: { q: "x" } }] };
    default:
      return { text: "done" };
  }
};

describe("runHarnessConformance", () => {
  test("scripted adapter passes every shared scenario", async () => {
    const { adapter, driver } = scriptedConformanceDriver(plan);
    const bridge = staticToolBridge(
      [{ name: "lookup", inputSchema: { type: "object" } }],
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result = await runHarnessConformance({
      adapter,
      driver,
      toolBridge: bridge,
      timeoutMs: 3_000,
    });
    for (const check of result.checks.filter((entry) => !entry.passed)) {
      console.error(`FAIL ${check.name}: ${check.error}`);
    }
    const names = result.checks.map((check) => check.name);
    expect(names).toContain("simple turn");
    expect(names).toContain("interrupt turn");
    expect(names).toContain("approval request");
    expect(names).toContain("tool bridge");
    expect(result.success).toBe(true);
  });

  test("scenarios are gated by capabilities", async () => {
    const capabilities: HarnessCapabilities = {
      ...disabledCapabilities(),
      turns: {
        ...disabledCapabilities().turns,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        terminalStatusQuality: "strong",
      },
    };
    const adapter = new ScriptedHarnessAdapter({
      plan: () => ({ text: "ok" }),
      capabilities,
    });
    const driver: HarnessConformanceDriver = {
      async startSimpleTurn(session: HarnessSession, turnId: string) {
        await session.startTurn({ turnId, message: userMessage("hello") });
      },
    };
    const result = await runHarnessConformance({ adapter, driver, timeoutMs: 3_000 });
    const names = result.checks.map((check) => check.name);
    expect(names).toContain("simple turn");
    expect(names).not.toContain("interrupt turn");
    expect(names).not.toContain("approval request");
    expect(names).not.toContain("tool bridge");
    expect(result.success).toBe(true);
  });

  test("a turn that never terminates is reported as a failure", async () => {
    const adapter = new ScriptedHarnessAdapter({ plan: () => ({ delayMs: 60_000 }) });
    const driver: HarnessConformanceDriver = {
      async startSimpleTurn(session: HarnessSession, turnId: string) {
        await session.startTurn({ turnId, message: userMessage("hello") });
      },
    };
    const result = await runHarnessConformance({ adapter, driver, timeoutMs: 200 });
    expect(result.success).toBe(false);
    const simple = result.checks.find((check) => check.name === "simple turn");
    expect(simple?.passed).toBe(false);
  });
});
