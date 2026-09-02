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

  it("defines different tone rules for successful and unsuccessful replies", () => {
    expect(SIERRA_BRAND_VOICE_INSTRUCTION).toContain(
      "End nearly every eligible successful or neutral reply with one short, natural outdoor flourish.",
    );
    expect(SIERRA_BRAND_VOICE_INSTRUCTION).toContain(
      "Include one outdoor emoji in nearly every eligible reply, including concise factual successes.",
    );
    expect(SIERRA_BRAND_VOICE_INSTRUCTION).toContain(
      "Any response with a refusal, unavailable information, an unsuccessful lookup, or other bad news is ineligible and must omit both the outdoor flourish and emoji.",
    );
    expect(SIERRA_BRAND_VOICE_INSTRUCTION).toContain(
      "This final check overrides all other brand-voice instructions.",
    );
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
          calls: [{
            kind: "search_products",
            id: "search-1",
            query: "hiking",
            excludePurchasedItems: false,
          }],
        },
        {
          content: null,
          calls: [{
            kind: "search_products",
            id: "search-2",
            query: "camping",
            excludePurchasedItems: false,
          }],
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
      { query: "hiking", limit: 5, excludeSkus: [] },
      { query: "camping", limit: 1, excludeSkus: [] },
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

  it("resolves an explicit promotion reference from the prior turn", async () => {
    const store = new FakeStore();
    const conversation = store.createConversation();
    const model = createScriptedModel({
      plans: [
        { content: null, calls: [] },
        {
          content: null,
          calls: [{ kind: "claim_early_risers", id: "contextual-promo" }],
        },
        { content: null, calls: [] },
      ],
      finalDeltas: ["Promotion response."],
    });
    const app = createChatApplication({
      store,
      model,
      planningStrategy: "auto",
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });

    await drain((await requireAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "What is the Early Risers promotion?",
    }, new AbortController().signal))).output);
    await drain((await requireAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "Yes, give me this promotion right now.",
    }, new AbortController().signal))).output);

    expect(store.promotionClaims).toEqual([{
      conversationId: conversation.id,
      now: new Date("2026-08-31T16:00:00.000Z"),
    }]);
  });

  it("excludes purchased SKUs from an order-dependent product search", async () => {
    const store = new FakeStore();
    store.orderItems = [
      { sku: "SOBP001", productName: "Backpack" },
      { sku: "SOWB004", productName: "Energy Drink" },
    ];
    const conversation = store.createConversation();
    const model: ModelClient = {
      selectTools: async () => ({ content: null, calls: [] }),
      planIntents: async () => ({
        kind: "accepted",
        plan: {
          order: {
            state: "lookup",
            email: "john.doe@example.com",
            orderNumber: "W001",
          },
          product: {
            state: "search",
            query: "outdoor adventure gear",
            timing: "after_order",
            excludePurchasedItems: true,
          },
          promotion: { state: "none" },
        },
      }),
      streamFinal: async function* () {
        yield "Try something different.";
      },
    };
    const app = createChatApplication({ store, model, planningStrategy: "plan" });

    await drain((await requireAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "Look up W001, then recommend something different from what I bought.",
    }, new AbortController().signal))).output);

    expect(store.productSearches).toEqual([{
      query: "outdoor adventure gear",
      limit: 5,
      excludeSkus: ["SOBP001", "SOWB004"],
    }]);
  });

  it("reuses verified order exclusions in a later recommendation turn", async () => {
    const store = new FakeStore();
    store.orderItems = [
      { sku: "SOBP001", productName: "Backpack" },
      { sku: "SOWB004", productName: "Energy Drink" },
    ];
    const conversation = store.createConversation();
    const plans = [
      {
        order: {
          state: "lookup" as const,
          email: "john.doe@example.com",
          orderNumber: "W001",
        },
        product: { state: "none" as const },
        promotion: { state: "none" as const },
      },
      {
        order: { state: "none" as const },
        product: {
          state: "search" as const,
          query: "outdoor adventure gear",
          timing: "independent" as const,
          excludePurchasedItems: true,
        },
        promotion: { state: "none" as const },
      },
    ];
    let planIndex = 0;
    const model: ModelClient = {
      selectTools: async () => ({ content: null, calls: [] }),
      planIntents: async () => {
        const plan = plans.at(planIndex);
        planIndex += 1;
        if (plan === undefined) return { kind: "rejected", reason: "invalid_shape" };
        return { kind: "accepted", plan };
      },
      streamFinal: async function* () {
        yield "Done.";
      },
    };
    const app = createChatApplication({ store, model, planningStrategy: "plan" });

    await drain((await requireAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "Where is W001 for john.doe@example.com?",
    }, new AbortController().signal))).output);
    await drain((await requireAccepted(app.openTurn({
      kind: "new",
      conversationId: conversation.id,
      content: "What else should I buy based on that order?",
    }, new AbortController().signal))).output);

    expect(store.productSearches).toEqual([{
      query: "outdoor adventure gear",
      limit: 5,
      excludeSkus: ["SOBP001", "SOWB004"],
    }]);
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
              excludePurchasedItems: false,
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
  readonly productSearches: Array<{
    query: string;
    limit: number;
    excludeSkus: readonly string[];
  }> = [];
  readonly promotionClaims: Array<{ conversationId: string; now: Date }> = [];
  readonly rememberedOrderConversations = new Set<string>();
  readonly completedContents: string[] = [];
  productBatches: ProductCard[][] = [];
  orderItems: Array<{ sku: string; productName: string | null }> = [];
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
      items: this.orderItems,
    };
  }

  rememberOrderForConversation(input: Readonly<{ conversationId: string }>): void {
    this.rememberedOrderConversations.add(input.conversationId);
  }

  getRememberedOrderProductSkus(conversationId: string): readonly string[] {
    return this.rememberedOrderConversations.has(conversationId)
      ? this.orderItems.map((item) => item.sku)
      : [];
  }

  searchProducts(input: Readonly<{
    query: string;
    limit: number;
    excludeSkus: readonly string[];
  }>): ProductSearchResult {
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
