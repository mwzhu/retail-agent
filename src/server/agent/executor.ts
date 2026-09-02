import type {
  OrderLookupResult,
  ProductCard,
  ProductSearchResult,
  PromotionResult,
  SierraStore,
} from "../contracts";
import { summarizeProductDescription } from "../product-description";
import { hasExplicitPromotionIntent } from "./intents";
import type { ModelToolCall } from "./capabilities";

const MAX_PRODUCT_RECORDS = 5;
const PROMOTION_WINDOW: "8:00-10:00 AM Pacific" = "8:00-10:00 AM Pacific";

export interface CapabilityExecutionContext {
  readonly conversationId: string;
  readonly sourceContent: string;
  readonly priorContents: readonly string[];
}

export type CapabilityOutcome =
  | Readonly<{
      tool: "lookup_order";
      kind: OrderLookupResult["kind"];
      itemSkus: readonly string[];
    }>
  | Readonly<{
      tool: "search_products";
      kind: ProductSearchResult["kind"];
      productSkus: readonly string[];
      excludedSkus: readonly string[];
    }>
  | Readonly<{
      tool: "claim_early_risers";
      kind: PromotionResult["kind"];
    }>;

export type CapabilityExecutionResult = Readonly<{
  content: string;
  outcome: CapabilityOutcome;
}>;

export interface CapabilityExecutor {
  execute(call: ModelToolCall): Promise<CapabilityExecutionResult>;
}

export type CapabilityExecutorFactory = (
  context: CapabilityExecutionContext,
) => CapabilityExecutor;

export function createCapabilityExecutorFactory(input: Readonly<{
  store: SierraStore;
  now: () => Date;
}>): CapabilityExecutorFactory {
  return (context) => {
    let productsRemaining = MAX_PRODUCT_RECORDS;
    return {
      execute: async (call) => {
        const result = executeCapability({
          call,
          context,
          store: input.store,
          now: input.now,
          productsRemaining,
        });
        productsRemaining = result.productsRemaining;
        return { content: JSON.stringify(result.value), outcome: result.outcome };
      },
    };
  };
}

function executeCapability(input: Readonly<{
  call: ModelToolCall;
  context: CapabilityExecutionContext;
  store: SierraStore;
  now: () => Date;
  productsRemaining: number;
}>): Readonly<{
  value: unknown;
  outcome: CapabilityOutcome;
  productsRemaining: number;
}> {
  switch (input.call.kind) {
    case "lookup_order": {
      const value = input.store.lookupOrder({
        email: input.call.email,
        orderNumber: input.call.orderNumber,
      });
      if (value.kind === "found") {
        input.store.rememberOrderForConversation({
          conversationId: input.context.conversationId,
          orderNumber: value.orderNumber,
        });
      }
      return {
        value,
        outcome: {
          tool: input.call.kind,
          kind: value.kind,
          itemSkus: value.kind === "found" ? value.items.map((item) => item.sku) : [],
        },
        productsRemaining: input.productsRemaining,
      };
    }
    case "search_products": {
      const orderContext = input.call.excludePurchasedItems
        ? input.store.getVerifiedOrderContext(input.context.conversationId)
        : null;
      const excludedSkus = orderContext?.order.items.map((item) => item.sku) ?? [];
      const recommendationQuery = orderContext?.recommendationTerms.join(" ").trim();
      const query = recommendationQuery === undefined || recommendationQuery.length === 0
        ? input.call.query
        : recommendationQuery;
      const value = searchProductsWithinBudget({
        store: input.store,
        query,
        productsRemaining: input.productsRemaining,
        excludeSkus: excludedSkus,
      });
      return {
        value: value.result,
        outcome: {
          tool: input.call.kind,
          kind: value.result.kind,
          productSkus: value.result.products.map((product) => product.sku),
          excludedSkus,
        },
        productsRemaining: value.productsRemaining,
      };
    }
    case "claim_early_risers": {
      const value = claimPromotionWithExplicitIntent({
        store: input.store,
        context: input.context,
        now: input.now,
      });
      return {
        value,
        outcome: { tool: input.call.kind, kind: value.kind },
        productsRemaining: input.productsRemaining,
      };
    }
    default: {
      const exhaustive: never = input.call;
      return exhaustive;
    }
  }
}

function searchProductsWithinBudget(input: Readonly<{
  store: SierraStore;
  query: string;
  productsRemaining: number;
  excludeSkus: readonly string[];
}>): Readonly<{ result: ProductSearchResult; productsRemaining: number }> {
  if (input.productsRemaining === 0) {
    return {
      result: { kind: "matches", query: input.query, products: [] },
      productsRemaining: 0,
    };
  }

  const result = input.store.searchProducts({
    query: input.query,
    limit: input.productsRemaining,
    excludeSkus: input.excludeSkus,
  });
  const products = result.products.slice(0, input.productsRemaining).map(projectProduct);
  return {
    result: { kind: "matches", query: result.query, products },
    productsRemaining: input.productsRemaining - products.length,
  };
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
  context: CapabilityExecutionContext;
  now: () => Date;
}>): PromotionResult {
  if (!hasExplicitPromotionIntent(
    input.context.sourceContent,
    input.context.priorContents,
  )) {
    return { kind: "not_explicit", window: PROMOTION_WINDOW };
  }
  return input.store.claimPromotion({
    conversationId: input.context.conversationId,
    now: input.now(),
  });
}
