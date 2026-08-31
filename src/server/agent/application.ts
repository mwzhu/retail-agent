import type {
  ProductCard,
  ProductSearchResult,
  PromotionResult,
  SierraStore,
} from "../contracts";
import type { ChatMessage, TurnErrorCode } from "../../shared/protocol";
import { FINAL_RESPONSE_INSTRUCTION, SIERRA_SYSTEM_PROMPT } from "./prompt";
import { hasExplicitPromotionIntent } from "./intents";
import { summarizeProductDescription } from "../product-description";
import {
  ModelClientError,
  type ChatApplication,
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
  type OpenTurnResult,
  type TurnCommand,
  type TurnTerminal,
} from "./types";

const MAX_HISTORY_MESSAGES = 20;
const MAX_PLANNING_ROUNDS = 3;
const MAX_PRODUCT_RECORDS = 5;
const PROMOTION_WINDOW: "8:00-10:00 AM Pacific" = "8:00-10:00 AM Pacific";

interface TurnContext {
  readonly conversationId: string;
  readonly source: ChatMessage;
  readonly history: readonly ChatMessage[];
}

interface ToolBudget {
  productsRemaining: number;
}

export function createChatApplication(input: Readonly<{
  store: SierraStore;
  model: ModelClient;
  now?: () => Date;
}>): ChatApplication {
  const busyConversations = new Set<string>();
  const now = input.now ?? (() => new Date());

  return {
    createConversation: () => input.store.createConversation(),
    getConversation: (id) => input.store.getConversation(id),
    openTurn: async (command, signal) => {
      if (busyConversations.has(command.conversationId)) {
        return { kind: "rejected", reason: "conversation_busy" };
      }

      busyConversations.add(command.conversationId);
      try {
        const prepared = prepareTurn(input.store, command);
        if (prepared.kind === "rejected") {
          busyConversations.delete(command.conversationId);
          return { kind: "rejected", reason: prepared.rejection.kind };
        }

        const context: TurnContext = {
          conversationId: command.conversationId,
          source: prepared.turn.source,
          history: prepared.turn.history,
        };
        const output = runTurn({
          context,
          store: input.store,
          model: input.model,
          now,
          signal,
          release: () => busyConversations.delete(command.conversationId),
        });
        return {
          kind: "accepted",
          conversationId: command.conversationId,
          source: prepared.turn.source,
          output,
        };
      } catch (error) {
        busyConversations.delete(command.conversationId);
        throw error;
      }
    },
  };
}

function prepareTurn(store: SierraStore, command: TurnCommand) {
  switch (command.kind) {
    case "new":
      return store.prepareNewTurn({
        conversationId: command.conversationId,
        content: command.content,
      });
    case "retry":
      return store.prepareRetry(command.conversationId);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

async function* runTurn(input: Readonly<{
  context: TurnContext;
  store: SierraStore;
  model: ModelClient;
  now: () => Date;
  signal: AbortSignal;
  release: () => void;
}>): AsyncGenerator<Readonly<{ text: string }>, TurnTerminal, void> {
  try {
    if (input.signal.aborted) {
      return { kind: "aborted" };
    }

    const messages = buildInitialMessages(input.context);
    const budget: ToolBudget = { productsRemaining: MAX_PRODUCT_RECORDS };

    for (let round = 0; round < MAX_PLANNING_ROUNDS; round += 1) {
      const plan = await input.model.plan({ messages, signal: input.signal });
      if (input.signal.aborted) {
        return { kind: "aborted" };
      }
      if (plan.calls.length === 0) {
        break;
      }

      messages.push({ kind: "tool_calls", content: plan.content, calls: plan.calls });
      for (const call of plan.calls) {
        const result = executeTool({
          call,
          context: input.context,
          store: input.store,
          now: input.now,
          budget,
        });
        messages.push({
          kind: "tool_result",
          callId: call.id,
          name: call.kind,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({
      kind: "text",
      role: "system",
      content: FINAL_RESPONSE_INSTRUCTION,
    });

    let finalText = "";
    for await (const text of input.model.streamFinal({
      messages,
      signal: input.signal,
    })) {
      if (input.signal.aborted) {
        return { kind: "aborted" };
      }
      if (text.length === 0) {
        continue;
      }
      finalText += text;
      yield { text };
    }

    if (input.signal.aborted) {
      return { kind: "aborted" };
    }
    if (finalText.trim().length === 0) {
      return failedTerminal(
        "EMPTY_FINAL_RESPONSE",
        "The assistant returned an empty response. Please retry.",
      );
    }

    const assistant = input.store.completeTurn({
      sourceMessageId: input.context.source.id,
      content: finalText,
    });
    return { kind: "completed", assistant };
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) {
      return { kind: "aborted" };
    }
    if (error instanceof ModelClientError) {
      return failedTerminal(error.code, safeModelErrorMessage(error.code));
    }
    return failedTerminal("INTERNAL", "The turn could not be completed. Please retry.");
  } finally {
    input.release();
  }
}

function buildInitialMessages(context: TurnContext): ModelMessage[] {
  const historyWithoutSource = context.history.filter(
    (message) => message.id !== context.source.id,
  );
  const recentHistory = [...historyWithoutSource, context.source].slice(
    -MAX_HISTORY_MESSAGES,
  );

  return [
    { kind: "text", role: "system", content: SIERRA_SYSTEM_PROMPT },
    ...recentHistory.map(toModelTextMessage),
  ];
}

function toModelTextMessage(message: ChatMessage): ModelMessage {
  return {
    kind: "text",
    role: message.role,
    content: message.content,
  };
}

function executeTool(input: Readonly<{
  call: ModelToolCall;
  context: TurnContext;
  store: SierraStore;
  now: () => Date;
  budget: ToolBudget;
}>): unknown {
  switch (input.call.kind) {
    case "lookup_order":
      return input.store.lookupOrder({
        email: input.call.email,
        orderNumber: input.call.orderNumber,
      });
    case "search_products":
      return searchProductsWithinBudget({
        store: input.store,
        query: input.call.query,
        budget: input.budget,
      });
    case "claim_early_risers":
      return claimPromotionWithExplicitIntent({
        store: input.store,
        context: input.context,
        now: input.now,
      });
    default: {
      const exhaustive: never = input.call;
      return exhaustive;
    }
  }
}

function searchProductsWithinBudget(input: Readonly<{
  store: SierraStore;
  query: string;
  budget: ToolBudget;
}>): ProductSearchResult {
  if (input.budget.productsRemaining === 0) {
    return { kind: "matches", query: input.query, products: [] };
  }

  const result = input.store.searchProducts({
    query: input.query,
    limit: input.budget.productsRemaining,
  });
  const products = result.products
    .slice(0, input.budget.productsRemaining)
    .map(projectProduct);
  input.budget.productsRemaining -= products.length;
  return { kind: "matches", query: result.query, products };
}

function projectProduct(product: ProductCard): ProductCard {
  return {
    sku: product.sku,
    name: product.name,
    inventory: product.inventory,
    tags: product.tags,
    description: summarizeProductDescription(product.description),
  };
}

function claimPromotionWithExplicitIntent(input: Readonly<{
  store: SierraStore;
  context: TurnContext;
  now: () => Date;
}>): PromotionResult {
  if (!hasExplicitPromotionIntent(input.context.source.content)) {
    return { kind: "not_explicit", window: PROMOTION_WINDOW };
  }
  return input.store.claimPromotion({
    conversationId: input.context.conversationId,
    now: input.now(),
  });
}

function failedTerminal(code: TurnErrorCode, message: string): TurnTerminal {
  return { kind: "failed", code, message, retryable: true };
}

function safeModelErrorMessage(code: ModelClientError["code"]): string {
  switch (code) {
    case "MODEL_UNAVAILABLE":
      return "The assistant is unavailable right now. Please retry.";
    case "MODEL_TIMEOUT":
      return "The assistant took too long to respond. Please retry.";
    case "INTERNAL":
      return "The assistant could not complete the turn. Please retry.";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
