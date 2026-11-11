import { describe, expect, test } from "bun:test";
import type { HarnessEvent, HarnessTurn } from "../src/index.js";
import {
  assistantText,
  assertTurnEventContract,
  collectTurnEvents,
} from "../src/testing/index.js";

function turnEvent(overrides: Partial<HarnessTurn> = {}): HarnessEvent {
  return {
    type: "turn.started",
    turn: {
      id: "t1",
      nativeRef: { id: null, strength: "none" },
      ordinal: 1,
      status: "running",
      model: null,
      startedAt: null,
      completedAt: null,
      ...overrides,
    },
  };
}

function terminal(overrides: Partial<HarnessTurn> = {}): HarnessEvent {
  return {
    type: "turn.terminal",
    turn: {
      id: "t1",
      nativeRef: { id: null, strength: "none" },
      ordinal: 1,
      status: "completed",
      model: null,
      startedAt: null,
      completedAt: null,
      ...overrides,
    },
    failure: null,
  };
}

function validSequence(): HarnessEvent[] {
  return [
    turnEvent(),
    {
      type: "message.started",
      message: {
        id: "m1",
        turnId: "t1",
        role: "assistant",
        content: [],
        status: "pending",
        createdAt: "",
        completedAt: null,
      },
    },
    { type: "message.delta", messageId: "m1", text: "hello" },
    {
      type: "message.completed",
      message: {
        id: "m1",
        turnId: "t1",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        status: "completed",
        createdAt: "",
        completedAt: "",
      },
    },
    terminal(),
  ];
}

describe("assertTurnEventContract", () => {
  test("accepts a valid sequence", () => {
    expect(() => assertTurnEventContract(validSequence(), "t1")).not.toThrow();
  });

  test("rejects events emitted after the terminal", () => {
    const events = [...validSequence(), { type: "message.delta", messageId: "m1", text: "again" }];
    expect(() => assertTurnEventContract(events, "t1")).toThrow(/after turn\.terminal/);
  });

  test("rejects a missing terminal", () => {
    const events = validSequence().filter((event) => event.type !== "turn.terminal");
    expect(() => assertTurnEventContract(events, "t1")).toThrow(/never reached a terminal/);
  });

  test("rejects an unsettled tool at the terminal", () => {
    const events: HarnessEvent[] = [
      turnEvent(),
      {
        type: "tool.started",
        item: {
          id: "tool1",
          turnId: "t1",
          name: "bash",
          input: {},
          status: "running",
          startedAt: null,
          completedAt: null,
        },
      },
      terminal(),
    ];
    expect(() => assertTurnEventContract(events, "t1")).toThrow(/not settled/);
  });

  test("rejects a pending request at the terminal", () => {
    const events: HarnessEvent[] = [
      turnEvent(),
      {
        type: "request.updated",
        request: {
          id: "r1",
          turnId: "t1",
          nativeRef: { id: null, strength: "none" },
          kind: "approval",
          status: "pending",
          createdAt: "",
          resolvedAt: null,
        },
      },
      terminal(),
    ];
    expect(() => assertTurnEventContract(events, "t1")).toThrow(/pending at the turn terminal/);
  });
});

describe("collectTurnEvents", () => {
  test("associates deltas with the owning turn", () => {
    const events = validSequence();
    const collected = collectTurnEvents(events, "t1");
    expect(collected.filter((event) => event.type === "message.delta")).toHaveLength(1);
    expect(collectTurnEvents(events, "other")).toHaveLength(0);
  });
});

describe("assistantText", () => {
  test("uses the completed message content", () => {
    expect(assistantText(validSequence(), "t1")).toBe("hello");
  });
});
