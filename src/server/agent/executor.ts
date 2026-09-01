import type {
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
}

export type CapabilityExecutionResult = Readonly<{
  content: string;
  resultKind: string;
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
        return {
          content: JSON.stringify(result.value),
          resultKind: readResultKind(result.value),
        };
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
}>): Readonly<{ value: unknown; productsRemaining: number }> {
  switch (input.call.kind) {
    case "lookup_order":
      return {
        value: input.store.lookupOrder({
          email: input.call.email,
          orderNumber: input.call.orderNumber,
        }),
        productsRemaining: input.productsRemaining,
      };
    case "search_products": {
      const value = searchProductsWithinBudget({
        store: input.store,
        query: input.call.query,
        productsRemaining: input.productsRemaining,
      });
      return {
        value: value.result,
        productsRemaining: value.productsRemaining,
      };
    }
    case "claim_early_risers":
      return {
        value: claimPromotionWithExplicitIntent({
          store: input.store,
          context: input.context,
          now: input.now,
        }),
        productsRemaining: input.productsRemaining,
      };
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
  if (!hasExplicitPromotionIntent(input.context.sourceContent)) {
    return { kind: "not_explicit", window: PROMOTION_WINDOW };
  }
  return input.store.claimPromotion({
    conversationId: input.context.conversationId,
    now: input.now(),
  });
}

function readResultKind(value: unknown): string {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return "unknown";
  }
  return typeof value.kind === "string" ? value.kind : "unknown";
}
