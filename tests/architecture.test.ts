import { describe, expect, it } from "vitest";
import {
  createChatApplication,
  createToolDefinitions,
  validateIntentPlan,
  type AgentTraceEvent,
  type CapabilityExecutor,
  type IntentPlan,
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
  type OpenTurnResult,
  type TurnTerminal,
} from "../src/server/agent";
import { loadConfig } from "../src/server/config";
import { toOpenAIToolChoice } from "../src/server/agent/openai";
import type {
  OrderLookupResult,
  PrepareTurnResult,
  ProductSearchResult,
  PromotionResult,
  SierraStore,
} from "../src/server/contracts";
import type { ChatMessage, Conversation } from "../src/shared/protocol";

describe("planning strategies", () => {
  it("keeps historical auto selection and sequence routing distinct", async () => {
    const autoDirectives: unknown[] = [];
    const sequenceDirectives: unknown[] = [];
    await runSimpleTurn({
      strategy: "auto",
      content: "Recommend skis",
      model: selectionModel(autoDirectives),
    });
    await runSimpleTurn({
      strategy: "sequence",
      content: "Recommend skis",
      model: selectionModel(sequenceDirectives),
    });

    expect(autoDirectives).toEqual([{ kind: "auto" }]);
    expect(sequenceDirectives).toEqual([
      { kind: "required", name: "search_products" },
    ]);
  });

  it("plans once, executes all three intents exactly once, and preserves slot order", async () => {
    const store = new MemoryStore();
    const calls: ModelToolCall[] = [];
    const trace: AgentTraceEvent[] = [];
    let selectionCalls = 0;
    let planCalls = 0;
    let finalMessages: readonly ModelMessage[] = [];
    const model: ModelClient = {
      selectTools: async () => {
        selectionCalls += 1;
        return { content: null, calls: [] };
      },
      planIntents: async () => {
        planCalls += 1;
        return {
          kind: "accepted",
          plan: {
            order: {
              state: "lookup",
              email: "john.doe@example.com",
              orderNumber: "#W001",
            },
            product: {
              state: "search",
              query: "ski gear",
              timing: "independent",
            },
            promotion: { state: "claim" },
          },
        };
      },
      streamFinal: async function* (request) {
        finalMessages = request.messages;
        yield "Done.";
      },
    };
    const executor: CapabilityExecutor = {
      execute: async (call) => {
        calls.push(call);
        await delay(call.kind === "lookup_order" ? 15 : call.kind === "search_products" ? 5 : 10);
        return { content: JSON.stringify({ kind: `${call.kind}_result` }), resultKind: "ok" };
      },
    };
    const conversation = store.createConversation();
    const app = createChatApplication({
      store,
      model,
      planningStrategy: "plan",
      trace: { emit: (event) => trace.push(event) },
      executorFactory: () => executor,
    });

    await drainAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "Track my order, recommend skis, and claim Early Risers.",
    }, new AbortController().signal));

    expect(planCalls).toBe(1);
    expect(selectionCalls).toBe(0);
    expect(calls.map((call) => call.kind)).toEqual([
      "lookup_order",
      "search_products",
      "claim_early_risers",
    ]);
    const executionEvents = trace.filter((event) => event.kind.startsWith("execution."));
    expect(executionEvents.slice(0, 3).map((event) => event.kind)).toEqual([
      "execution.started",
      "execution.started",
      "execution.started",
    ]);
    expect(finalMessages
      .filter((message) => message.kind === "tool_result")
      .map((message) => message.name)).toEqual([
      "lookup_order",
      "search_products",
      "claim_early_risers",
    ]);
  });

  it("runs an order-dependent product search only after the order finishes", async () => {
    const sequence: string[] = [];
    const model = planModel({
      order: {
        state: "lookup",
        email: "john.doe@example.com",
        orderNumber: "#W001",
      },
      product: { state: "search", query: "related gear", timing: "after_order" },
      promotion: { state: "claim" },
    });
    await runSimpleTurn({
      strategy: "plan",
      content: "Track it, recommend something based on it, and claim Early Risers.",
      model,
      executor: {
        execute: async (call) => {
          sequence.push(`start:${call.kind}`);
          await delay(call.kind === "lookup_order" ? 10 : 1);
          sequence.push(`end:${call.kind}`);
          return { content: '{"kind":"ok"}', resultKind: "ok" };
        },
      },
    });

    expect(sequence.indexOf("end:lookup_order")).toBeLessThan(
      sequence.indexOf("start:search_products"),
    );
    expect(sequence.indexOf("start:claim_early_risers")).toBeLessThan(
      sequence.indexOf("end:lookup_order"),
    );
  });

  it("fails closed when a structured plan is rejected", async () => {
    let executions = 0;
    const model: ModelClient = {
      selectTools: async () => ({ content: null, calls: [] }),
      planIntents: async () => ({ kind: "rejected", reason: "invalid_shape" }),
      streamFinal: async function* () {
        yield "Please clarify.";
      },
    };
    await runSimpleTurn({
      strategy: "plan",
      content: "Do everything",
      model,
      executor: {
        execute: async () => {
          executions += 1;
          return { content: "{}", resultKind: "unknown" };
        },
      },
    });
    expect(executions).toBe(0);
  });

  it("ignores trace sink failures without changing the completed response", async () => {
    const store = new MemoryStore();
    const conversation = store.createConversation();
    const app = createChatApplication({
      store,
      model: selectionModel([]),
      trace: { emit: () => { throw new Error("trace offline"); } },
    });
    const terminal = await drainAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "Hello",
    }, new AbortController().signal));
    expect(terminal).toMatchObject({
      kind: "completed",
      assistant: { content: "Done." },
    });
  });
});

describe("tool specifications and config", () => {
  it("changes descriptions without changing capability structure", () => {
    const current = createToolDefinitions("current");
    const guided = createToolDefinitions("guided");
    expect(removeDescriptions(current)).toEqual(removeDescriptions(guided));
    expect(toolDescriptions(current)).not.toEqual(
      toolDescriptions(guided),
    );
  });

  it("defaults to the sequence strategy and current tool spec", () => {
    const config = loadConfig({});
    expect(config.planningStrategy).toBe("sequence");
    expect(config.toolSpecVersion).toBe("current");
  });

  it("preserves the historical auto request shape", () => {
    expect(toOpenAIToolChoice({ kind: "auto" })).toBe("auto");
    expect(toOpenAIToolChoice({ kind: "required", name: "lookup_order" })).toEqual({
      type: "function",
      function: { name: "lookup_order" },
    });
  });

  it("rejects a dependent product slot without an order slot", () => {
    expect(validateIntentPlan({
      order: { state: "none" },
      product: { state: "search", query: "related gear", timing: "after_order" },
      promotion: { state: "none" },
    })).toEqual({ kind: "rejected", reason: "invalid_dependency" });
  });
});

function selectionModel(directives: unknown[]): ModelClient {
  return {
    selectTools: async (request) => {
      directives.push(request.directive);
      return { content: null, calls: [] };
    },
    planIntents: async () => ({
      kind: "accepted",
      plan: emptyPlan(),
    }),
    streamFinal: async function* () {
      yield "Done.";
    },
  };
}

function planModel(plan: IntentPlan): ModelClient {
  return {
    selectTools: async () => ({ content: null, calls: [] }),
    planIntents: async () => ({ kind: "accepted", plan }),
    streamFinal: async function* () {
      yield "Done.";
    },
  };
}

async function runSimpleTurn(input: Readonly<{
  strategy: "auto" | "sequence" | "plan";
  content: string;
  model: ModelClient;
  executor?: CapabilityExecutor;
}>): Promise<TurnTerminal> {
  const store = new MemoryStore();
  const conversation = store.createConversation();
  const executor = input.executor;
  const app = createChatApplication({
    store,
    model: input.model,
    planningStrategy: input.strategy,
    executorFactory: executor === undefined ? undefined : () => executor,
  });
  return drainAccepted(app.openTurn({
    kind: "new",
    conversationId: conversation.id,
    content: input.content,
  }, new AbortController().signal));
}

async function drainAccepted(result: Promise<OpenTurnResult>): Promise<TurnTerminal> {
  const opened = await result;
  if (opened.kind === "rejected") throw new Error(opened.reason);
  while (true) {
    const step = await opened.output.next();
    if (step.done) return step.value;
  }
}

function emptyPlan() {
  return {
    order: { state: "none" as const },
    product: { state: "none" as const },
    promotion: { state: "none" as const },
  };
}

function removeDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeDescriptions);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
    key === "description" ? [] : [[key, removeDescriptions(child)]]));
}

function toolDescriptions(tools: ReturnType<typeof createToolDefinitions>): string[] {
  return tools.flatMap((tool) =>
    tool.type === "function" && tool.function.description !== undefined
      ? [tool.function.description]
      : []);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class MemoryStore implements SierraStore {
  readonly conversations = new Map<string, Conversation>();
  #message = 0;

  createConversation(): Conversation {
    const conversation: Conversation = {
      id: `conversation-${this.conversations.size + 1}`,
      messages: [],
      pendingUserMessageId: null,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  getConversation(id: string): Conversation | null {
    return this.conversations.get(id) ?? null;
  }

  prepareNewTurn(input: Readonly<{ conversationId: string; content: string }>): PrepareTurnResult {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation === undefined) return { kind: "rejected", rejection: { kind: "conversation_not_found" } };
    const source = this.message("user", input.content);
    conversation.messages.push(source);
    conversation.pendingUserMessageId = source.id;
    return { kind: "ready", turn: { source, history: [...conversation.messages] } };
  }

  prepareRetry(): PrepareTurnResult {
    return { kind: "rejected", rejection: { kind: "no_pending_message" } };
  }

  completeTurn(input: Readonly<{ sourceMessageId: string; content: string }>): ChatMessage {
    const conversation = [...this.conversations.values()].find(
      (candidate) => candidate.pendingUserMessageId === input.sourceMessageId,
    );
    if (conversation === undefined) throw new Error("missing pending turn");
    const assistant = this.message("assistant", input.content);
    conversation.messages.push(assistant);
    conversation.pendingUserMessageId = null;
    return assistant;
  }

  lookupOrder(): OrderLookupResult { return { kind: "not_found" }; }
  searchProducts(input: Readonly<{ query: string }>): ProductSearchResult {
    return { kind: "matches", query: input.query, products: [] };
  }
  claimPromotion(): PromotionResult {
    return { kind: "outside_window", window: "8:00-10:00 AM Pacific", timing: "after" };
  }
  close(): void {}

  private message(role: ChatMessage["role"], content: string): ChatMessage {
    this.#message += 1;
    return {
      id: `message-${this.#message}`,
      role,
      content,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
  }
}
