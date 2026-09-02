import type { ChatMessage, Conversation } from "../shared/protocol";

export type OrderStatus = "delivered" | "in-transit" | "fulfilled" | "error";

export type TrackingInfo =
  | Readonly<{ kind: "tracked"; number: string; url: string }>
  | Readonly<{ kind: "untracked" }>;

export type OrderLookupResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "found";
      orderNumber: string;
      status: OrderStatus;
      statusSentence: string;
      tracking: TrackingInfo;
      items: ReadonlyArray<{ sku: string; productName: string | null }>;
    }>;

export type VerifiedOrderContext = Readonly<{
  order: Extract<OrderLookupResult, { kind: "found" }>;
  recommendationTerms: readonly string[];
}>;

export interface ProductCard {
  readonly sku: string;
  readonly name: string;
  readonly inventory: number;
  readonly tags: readonly string[];
  readonly description: string;
}

export type ProductSearchResult = Readonly<{
  kind: "matches";
  query: string;
  products: readonly ProductCard[];
}>;

export type PromotionResult =
  | Readonly<{
      kind: "not_explicit";
      window: "8:00-10:00 AM Pacific";
    }>
  | Readonly<{
      kind: "outside_window";
      window: "8:00-10:00 AM Pacific";
      timing: "before" | "after";
    }>
  | Readonly<{
      kind: "granted";
      code: string;
      percentOff: 10;
      alreadyGranted: boolean;
      pacificDate: string;
    }>;

export type StoreTurnRejection =
  | Readonly<{ kind: "conversation_not_found" }>
  | Readonly<{ kind: "pending_message_exists" }>
  | Readonly<{ kind: "no_pending_message" }>;

export type PreparedTurn = Readonly<{
  source: ChatMessage;
  history: readonly ChatMessage[];
}>;

export type PrepareTurnResult =
  | Readonly<{ kind: "ready"; turn: PreparedTurn }>
  | Readonly<{ kind: "rejected"; rejection: StoreTurnRejection }>;

export interface SierraStore {
  createConversation(): Conversation;
  getConversation(id: string): Conversation | null;
  prepareNewTurn(input: Readonly<{ conversationId: string; content: string }>): PrepareTurnResult;
  prepareRetry(conversationId: string): PrepareTurnResult;
  completeTurn(input: Readonly<{ sourceMessageId: string; content: string }>): ChatMessage;
  lookupOrder(input: Readonly<{ email: string; orderNumber: string }>): OrderLookupResult;
  rememberOrderForConversation(input: Readonly<{
    conversationId: string;
    orderNumber: string;
  }>): void;
  getVerifiedOrderContext(conversationId: string): VerifiedOrderContext | null;
  searchProducts(input: Readonly<{
    query: string;
    limit: number;
    excludeSkus: readonly string[];
  }>): ProductSearchResult;
  claimPromotion(input: Readonly<{ conversationId: string; now: Date }>): PromotionResult;
  close(): void;
}
