import type { HarnessCapabilities } from "../capabilities.js";
import type { HarnessEvent } from "../events.js";

/**
 * Structural validation for a capabilities object. Adapters should call this
 * in tests to catch a missing group or a mistyped flag before shipping.
 */
export function validateCapabilities(capabilities: HarnessCapabilities): string[] {
  const errors: string[] = [];
  if (typeof capabilities !== "object" || capabilities === null) {
    return ["capabilities must be an object"];
  }
  const groups = [
    "sessions",
    "threads",
    "turns",
    "streaming",
    "tools",
    "approvals",
    "input",
    "identity",
  ] as const;
  for (const group of groups) {
    if (typeof capabilities[group] !== "object" || capabilities[group] === null) {
      errors.push(`capabilities.${group} is required`);
    }
  }
  if (errors.length > 0) return errors;

  const booleanFields: Array<[string, boolean | undefined]> = [
    ["sessions.supportsModelSwitch", capabilities.sessions.supportsModelSwitch],
    ["sessions.supportsResume", capabilities.sessions.supportsResume],
    ["sessions.pendingRequestsSurviveRestart", capabilities.sessions.pendingRequestsSurviveRestart],
    ["threads.exposesNativeThreadId", capabilities.threads.exposesNativeThreadId],
    ["threads.canFork", capabilities.threads.canFork],
    ["threads.canReadSnapshot", capabilities.threads.canReadSnapshot],
    ["turns.exposesNativeTurnId", capabilities.turns.exposesNativeTurnId],
    ["turns.emitsTurnStarted", capabilities.turns.emitsTurnStarted],
    ["turns.emitsTurnCompleted", capabilities.turns.emitsTurnCompleted],
    ["turns.supportsInterrupt", capabilities.turns.supportsInterrupt],
    ["turns.supportsSteering", capabilities.turns.supportsSteering],
    ["turns.supportsQueuedMessages", capabilities.turns.supportsQueuedMessages],
    ["streaming.streamsAssistantText", capabilities.streaming.streamsAssistantText],
    ["streaming.streamsReasoning", capabilities.streaming.streamsReasoning],
    ["streaming.streamsToolOutput", capabilities.streaming.streamsToolOutput],
    ["streaming.emitsMessageCompleted", capabilities.streaming.emitsMessageCompleted],
    ["tools.exposesToolItemIds", capabilities.tools.exposesToolItemIds],
    ["tools.emitsToolStarted", capabilities.tools.emitsToolStarted],
    ["tools.emitsToolCompleted", capabilities.tools.emitsToolCompleted],
    ["tools.emitsToolOutput", capabilities.tools.emitsToolOutput],
    ["tools.supportsMcpTools", capabilities.tools.supportsMcpTools],
    ["approvals.supportsCommandApproval", capabilities.approvals.supportsCommandApproval],
    ["approvals.supportsFileReadApproval", capabilities.approvals.supportsFileReadApproval],
    ["approvals.supportsFileChangeApproval", capabilities.approvals.supportsFileChangeApproval],
    ["approvals.approvalsHaveNativeRequestIds", capabilities.approvals.approvalsHaveNativeRequestIds],
    ["approvals.approvalCallbacksAreLiveOnly", capabilities.approvals.approvalCallbacksAreLiveOnly],
    ["input.acceptsText", capabilities.input.acceptsText],
    ["input.acceptsImages", capabilities.input.acceptsImages],
    ["input.acceptsFiles", capabilities.input.acceptsFiles],
  ];
  for (const [path, value] of booleanFields) {
    if (typeof value !== "boolean") errors.push(`capabilities.${path} must be a boolean`);
  }

  if (typeof capabilities.sessions.maxConcurrentTurns !== "number" || capabilities.sessions.maxConcurrentTurns < 1) {
    errors.push("capabilities.sessions.maxConcurrentTurns must be a positive number");
  }
  if (capabilities.input.maxAttachments !== null && typeof capabilities.input.maxAttachments !== "number") {
    errors.push("capabilities.input.maxAttachments must be a number or null");
  }
  if (!["strong", "weak", "none"].includes(capabilities.turns.terminalStatusQuality)) {
    errors.push("capabilities.turns.terminalStatusQuality must be strong, weak, or none");
  }
  const strengths = ["strong", "weak", "none"];
  for (const [path, value] of [
    ["identity.nativeThreadIds", capabilities.identity.nativeThreadIds],
    ["identity.nativeTurnIds", capabilities.identity.nativeTurnIds],
    ["identity.nativeItemIds", capabilities.identity.nativeItemIds],
    ["identity.nativeRequestIds", capabilities.identity.nativeRequestIds],
  ] as const) {
    if (!strengths.includes(value)) errors.push(`capabilities.${path} must be strong, weak, or none`);
  }
  return errors;
}

export function assertCapabilitiesShape(capabilities: HarnessCapabilities): void {
  const errors = validateCapabilities(capabilities);
  if (errors.length > 0) {
    throw new Error(`Invalid capabilities:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
}

/** Collect every event belonging to a turn, in stream order. */
export function collectTurnEvents(
  events: ReadonlyArray<HarnessEvent>,
  turnId: string,
): HarnessEvent[] {
  const messageTurns = new Map<string, string | null>();
  const toolTurns = new Map<string, string | null>();
  const collected: HarnessEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "message.started":
      case "message.completed":
        messageTurns.set(event.message.id, event.message.turnId);
        if (event.message.turnId === turnId) collected.push(event);
        break;
      case "message.delta":
        if (messageTurns.get(event.messageId) === turnId) collected.push(event);
        break;
      case "tool.started":
      case "tool.completed":
        toolTurns.set(event.item.id, event.item.turnId);
        if (event.item.turnId === turnId) collected.push(event);
        break;
      case "tool.delta":
        if (toolTurns.get(event.itemId) === turnId) collected.push(event);
        break;
      case "turn.started":
      case "turn.updated":
      case "turn.terminal":
        if (event.turn.id === turnId) collected.push(event);
        break;
      case "request.updated":
        if (event.request.turnId === turnId) collected.push(event);
        break;
      default:
        break;
    }
  }
  return collected;
}

/**
 * Assert the ordering guarantees of the contract for one turn:
 * - `turn.started` comes before any message/tool/request event.
 * - `turn.terminal` is the last event for the turn.
 * - Every open message, tool, and request is settled before the terminal.
 */
export function assertTurnEventContract(
  events: ReadonlyArray<HarnessEvent>,
  turnId: string,
): void {
  const turnEvents = collectTurnEvents(events, turnId);
  if (turnEvents.length === 0) {
    throw new Error(`No events were emitted for turn ${turnId}`);
  }

  const terminalIndex = turnEvents.findIndex((event) => event.type === "turn.terminal");
  if (terminalIndex === -1) {
    throw new Error(`Turn ${turnId} never reached a terminal event`);
  }
  const terminal = turnEvents[terminalIndex];
  if (terminal.type !== "turn.terminal") {
    throw new Error("unreachable");
  }

  const startedIndex = turnEvents.findIndex((event) => event.type === "turn.started");
  if (startedIndex !== -1) {
    for (const event of turnEvents.slice(0, startedIndex)) {
      if (event.type !== "turn.updated") {
        throw new Error(`Turn ${turnId} emitted ${event.type} before turn.started`);
      }
    }
  }

  for (const event of turnEvents.slice(terminalIndex + 1)) {
    throw new Error(`Turn ${turnId} emitted ${event.type} after turn.terminal`);
  }

  const settledMessages = new Set<string>();
  const settledTools = new Set<string>();
  const settledRequests = new Set<string>();
  for (const event of turnEvents.slice(0, terminalIndex + 1)) {
    if (event.type === "message.completed") settledMessages.add(event.message.id);
    if (event.type === "tool.completed") settledTools.add(event.item.id);
    if (event.type === "request.updated" && event.request.status !== "pending") {
      settledRequests.add(event.request.id);
    }
  }

  for (const event of turnEvents.slice(0, terminalIndex)) {
    if (event.type === "message.started" && !settledMessages.has(event.message.id)) {
      throw new Error(`Message ${event.message.id} was not settled before the turn terminal`);
    }
    if (event.type === "tool.started" && !settledTools.has(event.item.id)) {
      throw new Error(`Tool ${event.item.id} was not settled before the turn terminal`);
    }
    if (event.type === "request.updated" && event.request.status === "pending" && !settledRequests.has(event.request.id)) {
      throw new Error(`Request ${event.request.id} was pending at the turn terminal`);
    }
  }

  const status = terminal.turn.status;
  if (status !== "completed" && status !== "interrupted" && status !== "cancelled" && status !== "failed") {
    throw new Error(`Turn ${turnId} terminal has non-terminal status ${status}`);
  }
}

/** Extract the final assistant text emitted for a turn. */
export function assistantText(events: ReadonlyArray<HarnessEvent>, turnId: string): string {
  let text = "";
  for (const event of collectTurnEvents(events, turnId)) {
    if (event.type === "message.delta" && event.text) text += event.text;
    if (event.type === "message.completed" && event.message.role === "assistant") {
      text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
  }
  return text;
}
