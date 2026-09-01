import { describe, expect, it } from "vitest";
import type {
  OrderLookupResult,
  PrepareTurnResult,
  ProductCard,
  ProductSearchResult,
  PromotionResult,
  SierraStore,
} from "../src/server/contracts";
import type { ChatMessage, Conversation } from "../src/shared/protocol";
import {
  createChatApplication,
  createDemoModelClient,
  ModelClientError,
  type ModelClient,
  type ModelMessage,
  type ModelPlanningResult,
  type OpenTurnResult,
  type TurnTerminal,
} from "../src/server/agent";
import {
  FINAL_RESPONSE_INSTRUCTION,
  SIERRA_BRAND_VOICE_INSTRUCTION,
  SIERRA_SYSTEM_PROMPT,
} from "../src/server/agent/prompt";

const TEST_DATE = "2026-08-31T12:00:00.000Z";

describe("Sierra brand voice", () => {
  it("includes the shared brand instruction once in each system prompt", () => {
    expect(countOccurrences(SIERRA_SYSTEM_PROMPT, SIERRA_BRAND_VOICE_INSTRUCTION)).toBe(1);
    expect(countOccurrences(FINAL_RESPONSE_INSTRUCTION, SIERRA_BRAND_VOICE_INSTRUCTION)).toBe(1);
  });

  it("varies demo branding instead of adding the same emoji to every reply", async () => {
    const messages = [
      {
        kind: "tool_result",
        callId: "promotion-call",
        name: "claim_early_risers",
        content: JSON.stringify({ kind: "granted", code: "EARLY-TEST" }),
      },
      {
        kind: "tool_result",
        callId: "order-call",
        name: "lookup_order",
        content: JSON.stringify({
          kind: "found",
          statusSentence: "Order #W001 has been delivered.",
          tracking: { kind: "tracked", url: "https://example.com/track" },
        }),
      },
      {
        kind: "tool_result",
        callId: "malformed-call",
        name: "lookup_order",
        content: "{not-json",
      },
    ] satisfies readonly ModelMessage[];
    const responses = await Promise.all(messages.map((message) => streamDemoResponse([message])));
    const usedEmojis = responses.flatMap((response) => response.match(/(?:🏔️|🌲|🥾|🧭|⛺|🌄)/gu) ?? []);

    expect(responses.some((response) => !/(?:🏔️|🌲|🥾|🧭|⛺|🌄)/u.test(response))).toBe(true);
    expect(responses.at(-1)).not.toMatch(/(?:🏔️|🌲|🥾|🧭|⛺|🌄)/u);
    expect(new Set(usedEmojis).size).toBeGreaterThanOrEqual(2);
  });

  it.each([
    {
      name: "a granted promotion",
      message: {
        kind: "tool_result",
        callId: "promotion-call",
        name: "claim_early_risers",
        content: JSON.stringify({ kind: "granted", code: "EARLY-TEST" }),
      } satisfies ModelMessage,
      expectedText: "EARLY-TEST",
    },
    {
      name: "a malformed tool result",
      message: {
        kind: "tool_result",
        callId: "order-call",
        name: "lookup_order",
        content: "{not-json",
      } satisfies ModelMessage,
      expectedText: "could not read",
    },
  ])("keeps $name concise", async ({ message, expectedText }) => {
    const response = await streamDemoResponse([message]);

    expect(response).toContain(expectedText);
    expect(response.length).toBeLessThan(240);
  });
});

describe("ChatApplication", () => {
  it("executes the model-selected order lookup with both required identifiers", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    const planningMessages: ModelMessage[][] = [];
    const model = createScriptedModel({
      plans: [
        {
          content: null,
          calls: [
            {
              kind: "lookup_order",
              id: "order-call",
              email: "john.doe@example.com",
              orderNumber: "#W001",
            },
          ],
        },
        { content: null, calls: [] },
      ],
      onPlan: (messages) => planningMessages.push([...messages]),
      finalDeltas: ["Order found."],
    });
    const app = createChatApplication({ store, model });

    const accepted = await requireAccepted(
      app.openTurn(
        {
          kind: "new",
          conversationId: conversation.id,
          content: "Track #W001 for john.doe@example.com",
        },
        new AbortController().signal,
      ),
    );
    const turn = await drain(accepted.output);

    expect(turn.terminal.kind).toBe("completed");
    expect(store.orderLookups).toEqual([
      { email: "john.doe@example.com", orderNumber: "#W001" },
    ]);
    expect(planningMessages.at(1)).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        callId: "order-call",
        name: "lookup_order",
      }),
    );
  });

  it("keeps one five-product budget across repeated searches", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    store.productBatches = [
      makeProducts(["A", "B", "C", "D"]),
      makeProducts(["E", "F", "G", "H"]),
    ];
    let finalMessages: readonly ModelMessage[] = [];
    const model = createScriptedModel({
      plans: [
        {
          content: null,
          calls: [{ kind: "search_products", id: "search-1", query: "hiking" }],
        },
        {
          content: null,
          calls: [{ kind: "search_products", id: "search-2", query: "camping" }],
        },
      ],
      onFinal: (messages) => {
        finalMessages = messages;
      },
      finalDeltas: ["Five grounded matches."],
    });
    const app = createChatApplication({ store, model });

    const accepted = await requireAccepted(
      app.openTurn(
        { kind: "new", conversationId: conversation.id, content: "Recommend gear" },
        new AbortController().signal,
      ),
    );
    await drain(accepted.output);

    expect(store.productSearches).toEqual([
      { query: "hiking", limit: 5 },
      { query: "camping", limit: 1 },
    ]);
    const returnedProducts = finalMessages
      .filter((message) => message.kind === "tool_result")
      .flatMap((message) => {
        const result: unknown = JSON.parse(message.content);
        return isProductSearchResult(result) ? result.products : [];
      });
    expect(returnedProducts).toHaveLength(5);
  });

  it("does not claim Early Risers unless the current user explicitly asks for it", async () => {
    const store = new FakeStore();
    const model = createScriptedModel({
      plans: [
        {
          content: null,
          calls: [{ kind: "claim_early_risers", id: "promo-1" }],
        },
        { content: null, calls: [] },
        {
          content: null,
          calls: [{ kind: "claim_early_risers", id: "promo-2" }],
        },
        { content: null, calls: [] },
        {
          content: null,
          calls: [{ kind: "claim_early_risers", id: "promo-3" }],
        },
        { content: null, calls: [] },
        {
          content: null,
          calls: [{ kind: "claim_early_risers", id: "promo-4" }],
        },
        { content: null, calls: [] },
      ],
      finalDeltas: ["Promotion response."],
    });
    const app = createChatApplication({
      store,
      model,
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });
    const informational = store.createConversation();
    const negatedClaim = store.createConversation();
    const negatedSend = store.createConversation();
    const explicit = store.createConversation();

    const first = await requireAccepted(
      app.openTurn(
        {
          kind: "new",
          conversationId: informational.id,
          content: "Does the Early Risers promotion apply to me?",
        },
        new AbortController().signal,
      ),
    );
    await drain(first.output);
    expect(store.promotionClaims).toHaveLength(0);

    const second = await requireAccepted(
      app.openTurn(
        {
          kind: "new",
          conversationId: negatedClaim.id,
          content: "Do not claim the Early Risers promotion.",
        },
        new AbortController().signal,
      ),
    );
    await drain(second.output);
    expect(store.promotionClaims).toHaveLength(0);

    const third = await requireAccepted(
      app.openTurn(
        {
          kind: "new",
          conversationId: negatedSend.id,
          content: "Never send me the Early Risers discount.",
        },
        new AbortController().signal,
      ),
    );
    await drain(third.output);
    expect(store.promotionClaims).toHaveLength(0);

    const fourth = await requireAccepted(
      app.openTurn(
        {
          kind: "new",
          conversationId: explicit.id,
          content: "Please give me the Early Risers promotion.",
        },
        new AbortController().signal,
      ),
    );
    await drain(fourth.output);
    expect(store.promotionClaims).toEqual([
      {
        conversationId: explicit.id,
        now: new Date("2026-08-31T16:00:00.000Z"),
      },
    ]);
  });

  it("yields final text deltas and commits their exact concatenation", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    const model = createScriptedModel({
      plans: [{ content: null, calls: [] }],
      finalDeltas: ["Trail ", "ready."],
    });
    const app = createChatApplication({ store, model });

    const accepted = await requireAccepted(
      app.openTurn(
        { kind: "new", conversationId: conversation.id, content: "Hello" },
        new AbortController().signal,
      ),
    );
    const turn = await drain(accepted.output);

    expect(turn.deltas).toEqual(["Trail ", "ready."]);
    expect(turn.terminal).toMatchObject({
      kind: "completed",
      assistant: { role: "assistant", content: "Trail ready." },
    });
    expect(store.completedContents).toEqual(["Trail ready."]);
  });

  it("leaves the durable user message pending when the model fails", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    const model: ModelClient = {
      selectTools: async () => {
        throw new ModelClientError("MODEL_UNAVAILABLE", "provider detail");
      },
      planIntents: async () => ({
        kind: "accepted",
        plan: emptyIntentPlan(),
      }),
      streamFinal: async function* () {
        yield "unreachable";
      },
    };
    const app = createChatApplication({ store, model });

    const accepted = await requireAccepted(
      app.openTurn(
        { kind: "new", conversationId: conversation.id, content: "Hello" },
        new AbortController().signal,
      ),
    );
    const turn = await drain(accepted.output);

    expect(turn.terminal).toEqual({
      kind: "failed",
      code: "MODEL_UNAVAILABLE",
      message: "The assistant is unavailable right now. Please retry.",
      retryable: true,
    });
    expect(store.completedContents).toHaveLength(0);
    expect(store.getConversation(conversation.id)?.pendingUserMessageId).toBe(
      accepted.source.id,
    );
  });

  it("caps planning at three rounds and makes one final streaming call", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    store.productBatches = [makeProducts(["A"]), makeProducts(["B"]), makeProducts(["C"])];
    let planningCalls = 0;
    let finalCalls = 0;
    const model: ModelClient = {
      selectTools: async () => {
        planningCalls += 1;
        return {
          content: null,
          calls: [
            {
              kind: "search_products",
              id: `search-${planningCalls}`,
              query: "gear",
            },
          ],
        };
      },
      planIntents: async () => ({
        kind: "accepted",
        plan: emptyIntentPlan(),
      }),
      streamFinal: async function* () {
        finalCalls += 1;
        yield "Done.";
      },
    };
    const app = createChatApplication({ store, model });

    const accepted = await requireAccepted(
      app.openTurn(
        { kind: "new", conversationId: conversation.id, content: "Find gear" },
        new AbortController().signal,
      ),
    );
    await drain(accepted.output);

    expect(planningCalls).toBe(3);
    expect(finalCalls).toBe(1);
  });
});

class FakeStore implements SierraStore {
  readonly conversations = new Map<string, Conversation>();
  readonly orderLookups: Array<{ email: string; orderNumber: string }> = [];
  readonly productSearches: Array<{ query: string; limit: number }> = [];
  readonly promotionClaims: Array<{ conversationId: string; now: Date }> = [];
  readonly completedContents: string[] = [];
  productBatches: ProductCard[][] = [];
  #conversationSequence = 0;
  #messageSequence = 0;

  createConversation(): Conversation {
    this.#conversationSequence += 1;
    const conversation: Conversation = {
      id: `conversation-${this.#conversationSequence}`,
      messages: [],
      pendingUserMessageId: null,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  getConversation(id: string): Conversation | null {
    return this.conversations.get(id) ?? null;
  }

  prepareNewTurn(
    input: Readonly<{ conversationId: string; content: string }>,
  ): PrepareTurnResult {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation === undefined) {
      return {
        kind: "rejected",
        rejection: { kind: "conversation_not_found" },
      };
    }
    if (conversation.pendingUserMessageId !== null) {
      return {
        kind: "rejected",
        rejection: { kind: "pending_message_exists" },
      };
    }

    const source = this.createMessage("user", input.content);
    conversation.messages.push(source);
    conversation.pendingUserMessageId = source.id;
    return {
      kind: "ready",
      turn: { source, history: [...conversation.messages] },
    };
  }

  prepareRetry(conversationId: string): PrepareTurnResult {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      return {
        kind: "rejected",
        rejection: { kind: "conversation_not_found" },
      };
    }
    if (conversation.pendingUserMessageId === null) {
      return {
        kind: "rejected",
        rejection: { kind: "no_pending_message" },
      };
    }
    const source = conversation.messages.find(
      (message) => message.id === conversation.pendingUserMessageId,
    );
    if (source === undefined) {
      throw new Error("Fake store pending message is missing.");
    }
    return {
      kind: "ready",
      turn: { source, history: [...conversation.messages] },
    };
  }

  completeTurn(input: Readonly<{ sourceMessageId: string; content: string }>): ChatMessage {
    const conversation = [...this.conversations.values()].find(
      (candidate) => candidate.pendingUserMessageId === input.sourceMessageId,
    );
    if (conversation === undefined) {
      throw new Error("Fake store has no pending source message.");
    }
    const assistant = this.createMessage("assistant", input.content);
    conversation.messages.push(assistant);
    conversation.pendingUserMessageId = null;
    this.completedContents.push(input.content);
    return assistant;
  }

  lookupOrder(input: Readonly<{ email: string; orderNumber: string }>): OrderLookupResult {
    this.orderLookups.push(input);
    return {
      kind: "found",
      orderNumber: input.orderNumber,
      status: "delivered",
      statusSentence: `Order ${input.orderNumber} was delivered.`,
      tracking: {
        kind: "tracked",
        number: "TRACK-1",
        url: "https://example.test/TRACK-1",
      },
      items: [],
    };
  }

  searchProducts(input: Readonly<{ query: string; limit: number }>): ProductSearchResult {
    this.productSearches.push(input);
    return {
      kind: "matches",
      query: input.query,
      products: this.productBatches.shift() ?? [],
    };
  }

  claimPromotion(input: Readonly<{ conversationId: string; now: Date }>): PromotionResult {
    this.promotionClaims.push(input);
    return {
      kind: "granted",
      code: "EARLY-TEST",
      percentOff: 10,
      alreadyGranted: false,
      pacificDate: "2026-08-31",
    };
  }

  close(): void {}

  private createMessage(role: ChatMessage["role"], content: string): ChatMessage {
    this.#messageSequence += 1;
    return {
      id: `message-${this.#messageSequence}`,
      role,
      content,
      createdAt: TEST_DATE,
    };
  }
}

function createScriptedModel(input: Readonly<{
  plans: readonly ModelPlanningResult[];
  finalDeltas: readonly string[];
  onPlan?: (messages: readonly ModelMessage[]) => void;
  onFinal?: (messages: readonly ModelMessage[]) => void;
}>): ModelClient {
  let planIndex = 0;
  return {
    selectTools: async (request) => {
      input.onPlan?.(request.messages);
      const plan = input.plans.at(planIndex) ?? { content: null, calls: [] };
      planIndex += 1;
      return plan;
    },
    planIntents: async () => ({
      kind: "accepted",
      plan: emptyIntentPlan(),
    }),
    streamFinal: async function* (request) {
      input.onFinal?.(request.messages);
      for (const delta of input.finalDeltas) {
        yield delta;
      }
    },
  };
}

function emptyIntentPlan() {
  return {
    order: { state: "none" as const },
    product: { state: "none" as const },
    promotion: { state: "none" as const },
  };
}

async function requireAccepted(
  result: Promise<OpenTurnResult>,
): Promise<Extract<OpenTurnResult, { kind: "accepted" }>> {
  const resolved = await result;
  if (resolved.kind === "rejected") {
    throw new Error(`Expected accepted turn, received ${resolved.reason}.`);
  }
  return resolved;
}

async function drain(
  output: AsyncGenerator<Readonly<{ text: string }>, TurnTerminal, void>,
): Promise<{ deltas: string[]; terminal: TurnTerminal }> {
  const deltas: string[] = [];
  while (true) {
    const next = await output.next();
    if (next.done) {
      return { deltas, terminal: next.value };
    }
    deltas.push(next.value.text);
  }
}

function makeProducts(names: readonly string[]): ProductCard[] {
  return names.map((name) => ({
    sku: `SKU-${name}`,
    name,
    inventory: 1,
    tags: ["gear"],
    description: `${name} description`,
  }));
}

function isProductSearchResult(value: unknown): value is ProductSearchResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "kind" in value && value.kind === "matches" && "products" in value && Array.isArray(value.products);
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1;
}

async function streamDemoResponse(messages: readonly ModelMessage[]): Promise<string> {
  let response = "";
  for await (const delta of createDemoModelClient().streamFinal({
    messages,
    signal: new AbortController().signal,
  })) {
    response += delta;
  }
  return response;
}
