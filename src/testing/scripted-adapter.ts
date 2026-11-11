import {
  disabledCapabilities,
  type HarnessAdapter,
  type HarnessAdapterInfo,
  type HarnessApprovalOption,
  type HarnessCapabilities,
  type HarnessContentBlock,
  type HarnessFailure,
  type HarnessMessage,
  type HarnessRuntimeRequest,
  type HarnessRequestResponse,
  type HarnessSession,
  type HarnessSessionInfo,
  type HarnessSnapshot,
  type HarnessToolBridge,
  type HarnessToolItem,
  type HarnessTurn,
  type HarnessUserMessage,
  type InterruptTurnInput,
  type OpenSessionInput,
  type StartTurnInput,
  type SteerTurnInput,
} from "../index.js";
import { HarnessError } from "../errors.js";
import type { HarnessEvent } from "../events.js";
import { nativeRef } from "../ids.js";

/** A tool call the scripted harness will make through the host tool bridge. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly input?: Record<string, unknown>;
  /** When set, the adapter treats the bridge result as this error. */
  readonly isError?: boolean;
}

/** A runtime request the scripted harness will raise during a turn. */
export interface ScriptedRequest {
  readonly kind: "approval" | "user_input";
  readonly question?: string;
  readonly options?: ReadonlyArray<HarnessApprovalOption>;
}

/** The behavior of one scripted turn. */
export interface ScriptedTurn {
  readonly text?: string;
  readonly reasoning?: string;
  /** Emit assistant text as deltas. Defaults to `true`. */
  readonly stream?: boolean;
  readonly toolCalls?: ReadonlyArray<ScriptedToolCall>;
  readonly request?: ScriptedRequest;
  readonly failure?: HarnessFailure;
  /** How long the turn runs before completing. Defaults to `0`. */
  readonly delayMs?: number;
}

export type ScriptedTurnPlan = (turn: StartTurnInput) => ScriptedTurn | Promise<ScriptedTurn>;

export interface ScriptedHarnessOptions {
  readonly capabilities?: HarnessCapabilities;
  readonly plan: ScriptedTurnPlan;
  readonly now?: () => string;
}

interface EventConsumer {
  queue: HarnessEvent[];
  notify: (() => void) | null;
  closed: boolean;
}

class EventBus {
  private readonly consumers = new Set<EventConsumer>();

  publish(event: HarnessEvent): void {
    for (const consumer of this.consumers) consumer.queue.push(event);
    for (const consumer of this.consumers) consumer.notify?.();
  }

  subscribe(): AsyncIterable<HarnessEvent> {
    const consumer: EventConsumer = { queue: [], notify: null, closed: false };
    this.consumers.add(consumer);
    const consumers = this.consumers;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            while (consumer.queue.length === 0) {
              if (consumer.closed) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                consumer.notify = resolve;
                if (consumer.queue.length > 0) resolve();
              });
              consumer.notify = null;
            }
            return { done: false, value: consumer.queue.shift() as HarnessEvent };
          },
          async return(): Promise<IteratorResult<HarnessEvent>> {
            consumer.closed = true;
            consumers.delete(consumer);
            consumer.notify?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  close(): void {
    for (const consumer of this.consumers) {
      consumer.closed = true;
      consumer.notify?.();
    }
    this.consumers.clear();
  }
}

interface ActiveTurn {
  turn: HarnessTurn;
  timer: ReturnType<typeof setTimeout> | null;
  interrupted: boolean;
  settled: boolean;
  toolBridge?: HarnessToolBridge;
}

function defaultScriptedCapabilities(): HarnessCapabilities {
  const base = disabledCapabilities();
  return {
    ...base,
    turns: {
      ...base.turns,
      exposesNativeTurnId: true,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsSteering: true,
      terminalStatusQuality: "strong",
    },
    streaming: {
      ...base.streaming,
      streamsAssistantText: true,
      streamsReasoning: true,
      emitsMessageCompleted: true,
    },
    tools: {
      ...base.tools,
      exposesToolItemIds: true,
      emitsToolStarted: true,
      emitsToolCompleted: true,
      emitsToolOutput: true,
      supportsMcpTools: true,
    },
    approvals: {
      ...base.approvals,
      supportsCommandApproval: true,
      approvalsHaveNativeRequestIds: true,
    },
    identity: {
      ...base.identity,
      nativeTurnIds: "weak",
      nativeItemIds: "weak",
      nativeRequestIds: "weak",
    },
  };
}

export class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly info: HarnessAdapterInfo = {
    id: "scripted",
    label: "Scripted Harness",
    version: "0.1.0",
  };

  private readonly capabilities: HarnessCapabilities;
  private readonly plan: ScriptedTurnPlan;
  private readonly now: () => string;

  constructor(options: ScriptedHarnessOptions) {
    this.capabilities = options.capabilities ?? defaultScriptedCapabilities();
    this.plan = options.plan;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getCapabilities(): HarnessCapabilities {
    return this.capabilities;
  }

  async openSession(input: OpenSessionInput): Promise<HarnessSession> {
    return new ScriptedSession(this.info, this.capabilities, this.plan, this.now, input);
  }
}

class ScriptedSession implements HarnessSession {
  readonly id: string;
  private readonly adapterInfo: HarnessAdapterInfo;
  private readonly bus = new EventBus();
  private readonly capabilities: HarnessCapabilities;
  private readonly now: () => string;
  private readonly plan: ScriptedTurnPlan;
  private readonly sessionToolBridge: HarnessToolBridge | undefined;
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly messages = new Map<string, HarnessMessage>();
  private readonly tools = new Map<string, HarnessToolItem>();
  private readonly requests = new Map<string, HarnessRuntimeRequest>();
  private readonly requestWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private counter = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private sessionInfo: HarnessSessionInfo;

  constructor(
    adapterInfo: HarnessAdapterInfo,
    capabilities: HarnessCapabilities,
    plan: ScriptedTurnPlan,
    now: () => string,
    input: OpenSessionInput,
  ) {
    this.adapterInfo = adapterInfo;
    this.id = input.sessionId;
    this.capabilities = capabilities;
    this.now = now;
    this.plan = plan;
    this.sessionToolBridge = input.toolBridge;
    const timestamp = now();
    this.sessionInfo = {
      id: input.sessionId,
      adapterId: adapterInfo.id,
      status: "ready",
      cwd: input.cwd,
      model: input.model ?? null,
      capabilities,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.bus.publish({ type: "session.updated", session: this.sessionInfo });
  }

  get info(): HarnessSessionInfo {
    return this.sessionInfo;
  }

  subscribe(): AsyncIterable<HarnessEvent> {
    return this.bus.subscribe();
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private emit(event: HarnessEvent): void {
    if (!this.closed) this.bus.publish(event);
  }

  private updateSession(status: HarnessSessionInfo["status"], lastError: string | null = null): void {
    this.sessionInfo = { ...this.sessionInfo, status, lastError, updatedAt: this.now() };
    this.bus.publish({ type: "session.updated", session: this.sessionInfo });
  }

  async startTurn(input: StartTurnInput): Promise<HarnessTurn> {
    this.assertOpen();
    const timestamp = this.now();
    const turn: HarnessTurn = {
      id: input.turnId,
      nativeRef: nativeRef(
        this.capabilities.turns.exposesNativeTurnId ? `native-${input.turnId}` : null,
        this.capabilities.identity.nativeTurnIds,
      ),
      ordinal: this.turns.size + 1,
      status: "running",
      model: input.model ?? this.sessionInfo.model,
      startedAt: timestamp,
      completedAt: null,
    };
    const active: ActiveTurn = {
      turn,
      timer: null,
      interrupted: false,
      settled: false,
      toolBridge: input.toolBridge ?? this.sessionToolBridge,
    };
    this.turns.set(input.turnId, active);
    this.emit({ type: "turn.started", turn });
    void this.runTurn(active, input).catch((error: unknown) => {
      this.failTurn(active, this.toFailure(error));
    });
    return turn;
  }

  private async runTurn(active: ActiveTurn, input: StartTurnInput): Promise<void> {
    const scripted = await this.plan(input);
    if (active.interrupted) return;

    if (scripted.request) {
      const request = this.emitRequest(active, scripted.request);
      await this.waitForRequest(request.id);
      if (active.interrupted) return;
    }

    for (const toolCall of scripted.toolCalls ?? []) {
      if (active.interrupted) return;
      await this.runToolCall(active, toolCall);
    }

    if (scripted.failure) {
      this.failTurn(active, scripted.failure);
      return;
    }

    const delay = scripted.delayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        active.timer = setTimeout(() => {
          active.timer = null;
          resolve();
        }, delay);
      });
      if (active.interrupted) return;
    }

    if (scripted.reasoning !== undefined && this.capabilities.streaming.streamsReasoning) {
      const message = this.emitMessage(active, "assistant");
      this.emit({ type: "message.delta", messageId: message.id, reasoning: scripted.reasoning });
      this.completeMessage(message);
    }

    if (scripted.text !== undefined) {
      const message = this.emitMessage(active, "assistant");
      if (scripted.stream === false || !this.capabilities.streaming.streamsAssistantText) {
        this.replaceMessageContent(message, [{ type: "text", text: scripted.text }]);
        this.completeMessage(message);
      } else {
        for (const chunk of splitText(scripted.text)) {
          this.emit({ type: "message.delta", messageId: message.id, text: chunk });
        }
        this.replaceMessageContent(message, [{ type: "text", text: scripted.text }]);
        this.completeMessage(message);
      }
    }

    this.finishTurn(active, "completed", null);
  }

  private async runToolCall(active: ActiveTurn, toolCall: ScriptedToolCall): Promise<void> {
    const timestamp = this.now();
    const id = this.nextId("tool");
    const item: HarnessToolItem = {
      id,
      turnId: active.turn.id,
      name: toolCall.name,
      input: toolCall.input ?? {},
      status: "running",
      startedAt: timestamp,
      completedAt: null,
    };
    this.tools.set(id, item);
    this.emit({ type: "tool.started", item });

    let content: ReadonlyArray<{ type: "text"; text: string }>;
    let isError = false;
    try {
      if (!active.toolBridge) {
        throw new HarnessError({
          code: "unsupported",
          adapterId: this.adapterInfo.id,
          message: "No tool bridge is available for this turn",
        });
      }
      const bridgeResult = await active.toolBridge.callTool({
        id,
        name: toolCall.name,
        input: toolCall.input ?? {},
      });
      if (active.interrupted) return;
      content = bridgeResult.content.filter(
        (block): block is { type: "text"; text: string } => block.type === "text",
      );
      isError = toolCall.isError ?? bridgeResult.isError ?? false;
    } catch (error) {
      content = [{ type: "text", text: error instanceof Error ? error.message : String(error) }];
      isError = true;
    }

    const completed: HarnessToolItem = {
      ...item,
      status: isError ? "failed" : "completed",
      output: content.map((block) => block.text).join(""),
      error: isError ? content.map((block) => block.text).join("") : undefined,
      completedAt: this.now(),
    };
    this.tools.set(id, completed);
    this.emit({ type: "tool.completed", item: completed });
  }

  private emitRequest(active: ActiveTurn, scripted: ScriptedRequest): HarnessRuntimeRequest {
    const id = this.nextId("request");
    const request: HarnessRuntimeRequest = {
      id,
      turnId: active.turn.id,
      nativeRef: nativeRef(
        this.capabilities.approvals.approvalsHaveNativeRequestIds ? id : null,
        this.capabilities.identity.nativeRequestIds,
      ),
      kind: scripted.kind,
      status: "pending",
      ...(scripted.question !== undefined ? { question: scripted.question } : {}),
      ...(scripted.options !== undefined ? { options: scripted.options } : {}),
      createdAt: this.now(),
      resolvedAt: null,
    };
    this.requests.set(id, request);
    this.emit({ type: "request.updated", request });
    return request;
  }

  private waitForRequest(requestId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.requestWaiters.set(requestId, { resolve, reject });
    });
  }

  private toFailure(error: unknown): HarnessFailure {
    if (error instanceof HarnessError) {
      const class_: HarnessFailure["class"] =
        error.code === "usage_limit"
          ? "usage_limit"
          : error.code === "auth_required"
            ? "auth"
            : error.code === "interrupt_timeout"
              ? "timeout"
              : "protocol";
      return {
        class: class_,
        message: error.message,
        code: error.code,
        retryable: error.retryable,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    return {
      class: "unknown",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  private failTurn(active: ActiveTurn, failure: HarnessFailure): void {
    if (active.settled || this.closed) return;
    this.settleTurnItems(active);
    this.finishTurn(active, "failed", failure);
  }

  private settleTurnItems(active: ActiveTurn): void {
    const timestamp = this.now();
    for (const message of this.messages.values()) {
      if (
        message.turnId === active.turn.id &&
        (message.status === "pending" || message.status === "streaming")
      ) {
        const settled: HarnessMessage = { ...message, status: "failed", completedAt: timestamp };
        this.messages.set(message.id, settled);
        this.emit({ type: "message.completed", message: settled });
      }
    }
    for (const item of this.tools.values()) {
      if (item.turnId === active.turn.id && item.status === "running") {
        const settled: HarnessToolItem = {
          ...item,
          status: "cancelled",
          error: "Turn ended before the tool finished",
          completedAt: timestamp,
        };
        this.tools.set(item.id, settled);
        this.emit({ type: "tool.completed", item: settled });
      }
    }
    for (const request of this.requests.values()) {
      if (request.turnId === active.turn.id && request.status === "pending") {
        const settled: HarnessRuntimeRequest = {
          ...request,
          status: "cancelled",
          resolvedAt: timestamp,
        };
        this.requests.set(request.id, settled);
        this.emit({ type: "request.updated", request: settled });
        this.requestWaiters.get(request.id)?.resolve();
        this.requestWaiters.delete(request.id);
      }
    }
  }

  private finishTurn(
    active: ActiveTurn,
    status: HarnessTurn["status"],
    failure: HarnessFailure | null,
  ): void {
    if (active.settled || this.closed) return;
    active.settled = true;
    const timestamp = this.now();
    const turn: HarnessTurn = {
      ...active.turn,
      status,
      completedAt: timestamp,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    active.turn = turn;
    this.emit({ type: "turn.updated", turn });
    this.emit({ type: "turn.terminal", turn, failure });
  }

  interruptTurn(input: InterruptTurnInput): Promise<void> {
    this.assertOpen();
    const active = this.turns.get(input.turnId);
    if (!active) {
      return Promise.reject(
        new HarnessError({
          code: "invalid_input",
          adapterId: this.adapterInfo.id,
          message: `Unknown turn ${input.turnId}`,
        }),
      );
    }
    if (
      active.turn.status === "completed" ||
      active.turn.status === "interrupted" ||
      active.turn.status === "cancelled" ||
      active.turn.status === "failed"
    ) {
      return Promise.resolve();
    }
    active.interrupted = true;
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    this.settleTurnItems(active);
    this.finishTurn(active, "interrupted", null);
    return Promise.resolve();
  }

  respondToRequest(input: HarnessRequestResponse): Promise<void> {
    this.assertOpen();
    const request = this.requests.get(input.requestId);
    if (!request) {
      return Promise.reject(
        new HarnessError({
          code: "invalid_input",
          adapterId: this.adapterInfo.id,
          message: `Unknown runtime request ${input.requestId}`,
        }),
      );
    }
    if (request.status !== "pending") return Promise.resolve();
    const resolved: HarnessRuntimeRequest = {
      ...request,
      status: "resolved",
      resolvedAt: this.now(),
    };
    this.requests.set(request.id, resolved);
    this.emit({ type: "request.updated", request: resolved });
    this.requestWaiters.get(request.id)?.resolve();
    this.requestWaiters.delete(request.id);
    return Promise.resolve();
  }

  steerTurn(input: SteerTurnInput): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.turns.supportsSteering) {
      return Promise.reject(
        new HarnessError({
          code: "unsupported",
          adapterId: this.adapterInfo.id,
          message: "This harness does not support active steering",
        }),
      );
    }
    const active = this.turns.get(input.turnId);
    if (!active) {
      return Promise.reject(
        new HarnessError({
          code: "invalid_input",
          adapterId: this.adapterInfo.id,
          message: `Unknown turn ${input.turnId}`,
        }),
      );
    }
    const message = this.emitMessage(active, "user", input.message.content);
    this.completeMessage(message);
    return Promise.resolve();
  }

  async getSnapshot(): Promise<HarnessSnapshot> {
    return {
      session: this.sessionInfo,
      turns: [...this.turns.values()].map((active) => active.turn),
      messages: [...this.messages.values()],
      tools: [...this.tools.values()],
      requests: [...this.requests.values()],
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.closed) return;
      for (const active of this.turns.values()) {
        active.interrupted = true;
        if (active.timer) clearTimeout(active.timer);
      }
      for (const waiter of this.requestWaiters.values()) {
        waiter.reject(
          new HarnessError({
            code: "session_stopped",
            adapterId: this.adapterInfo.id,
            message: "Session closed while waiting for a response",
          }),
        );
      }
      this.requestWaiters.clear();
      this.updateSession("stopped");
      this.closed = true;
      this.bus.close();
    })();
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HarnessError({
        code: "session_stopped",
        adapterId: this.adapterInfo.id,
        message: `Session ${this.id} is closed`,
      });
    }
  }

  private emitMessage(
    active: ActiveTurn,
    role: HarnessMessage["role"],
    content: ReadonlyArray<HarnessContentBlock> = [],
  ): HarnessMessage {
    const message: HarnessMessage = {
      id: this.nextId("message"),
      turnId: active.turn.id,
      role,
      content,
      status: "pending",
      createdAt: this.now(),
      completedAt: null,
    };
    this.messages.set(message.id, message);
    this.emit({ type: "message.started", message });
    return message;
  }

  private replaceMessageContent(
    message: HarnessMessage,
    content: ReadonlyArray<HarnessContentBlock>,
  ): void {
    const updated: HarnessMessage = { ...message, content, status: "streaming" };
    this.messages.set(message.id, updated);
  }

  private completeMessage(message: HarnessMessage): void {
    const current = this.messages.get(message.id) ?? message;
    const updated: HarnessMessage = { ...current, status: "completed", completedAt: this.now() };
    this.messages.set(message.id, updated);
    this.emit({ type: "message.completed", message: updated });
  }
}

function splitText(text: string, size = 8): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

/** Build an adapter and a conformance driver from a scripted plan. */
export function scriptedConformanceDriver(plan: ScriptedTurnPlan): {
  adapter: ScriptedHarnessAdapter;
  driver: {
    startSimpleTurn: (session: HarnessSession, turnId: string) => Promise<void>;
    startLongTurn: (session: HarnessSession, turnId: string) => Promise<void>;
    startApprovalTurn: (session: HarnessSession, turnId: string) => Promise<void>;
    startToolTurn: (session: HarnessSession, turnId: string) => Promise<void>;
  };
} {
  const adapter = new ScriptedHarnessAdapter({ plan });
  const driver = {
    async startSimpleTurn(session: HarnessSession, turnId: string): Promise<void> {
      await session.startTurn({ turnId, message: userMessage("hello") });
    },
    async startLongTurn(session: HarnessSession, turnId: string): Promise<void> {
      await session.startTurn({ turnId, message: userMessage("long") });
    },
    async startApprovalTurn(session: HarnessSession, turnId: string): Promise<void> {
      await session.startTurn({ turnId, message: userMessage("approve") });
    },
    async startToolTurn(session: HarnessSession, turnId: string): Promise<void> {
      await session.startTurn({ turnId, message: userMessage("tool") });
    },
  };
  return { adapter, driver };
}

/** Helper to build a user message. */
export function userMessage(text: string): HarnessUserMessage {
  return { content: [{ type: "text", text }] };
}

/** Helper to build a simple static tool bridge for tests. */
export function staticToolBridge(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
  handler: (call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; isError?: boolean }>,
): HarnessToolBridge {
  return {
    listTools: () => tools.map((tool) => ({ ...tool })),
    callTool: async (call) => handler(call),
  };
}
