import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { ChatMessage, Conversation } from "../../shared/protocol";
import type {
  OrderLookupResult,
  OrderStatus,
  PrepareTurnResult,
  ProductCard,
  ProductSearchResult,
  PromotionResult,
  SierraStore,
  TrackingInfo,
} from "../contracts";
import {
  readOrderFixtures,
  readProductFixtures,
  type OrderFixture,
  type ProductFixture,
} from "./fixtures";
import { summarizeProductDescription } from "../product-description";

export interface OpenSierraStoreOptions {
  readonly databasePath: string;
  readonly ordersPath: string;
  readonly productsPath: string;
}

type MessageRow = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  position: number;
}>;

type PendingRow = Readonly<{
  conversation_id: string;
  source_message_id: string;
  position: number;
}>;

type ProductRow = Readonly<{
  sku: string;
  name: string;
  inventory: number;
  description: string;
  tags: string;
}>;

type OrderRow = Readonly<{
  id: number;
  order_number: string;
  status: OrderStatus;
  tracking_number: string | null;
}>;

type OrderItemRow = Readonly<{
  sku: string;
  product_name: string | null;
}>;

type OrderContextItemRow = Readonly<{ sku: string }>;

type PromotionGrantRow = Readonly<{
  code: string;
}>;

type PacificClock = Readonly<{
  date: string;
  minuteOfDay: number;
}>;

const PROMOTION_WINDOW = "8:00-10:00 AM Pacific";
const MAX_PRODUCT_RESULTS = 5;
const MAX_HISTORY_MESSAGES = 20;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "anything",
  "are",
  "can",
  "carry",
  "do",
  "does",
  "for",
  "i",
  "in",
  "into",
  "is",
  "it",
  "looking",
  "match",
  "matching",
  "me",
  "my",
  "of",
  "on",
  "or",
  "search",
  "that",
  "the",
  "this",
  "to",
  "with",
  "you",
  "your",
]);

const statusSentences: Readonly<Record<OrderStatus, string>> = {
  delivered: "This order has been delivered.",
  "in-transit": "This order is in transit.",
  fulfilled: "This order has been fulfilled.",
  error: "A reliable shipping status is not available from this record.",
};

const pacificFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      UNIQUE (conversation_id, id),
      UNIQUE (conversation_id, position),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pending_replies (
      conversation_id TEXT PRIMARY KEY,
      source_message_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id, source_message_id)
        REFERENCES messages(conversation_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      inventory INTEGER NOT NULL CHECK (inventory >= 0),
      description TEXT NOT NULL,
      tags TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
      sku,
      name,
      description,
      tags,
      content='products',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL,
      order_number TEXT NOT NULL,
      normalized_order_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('delivered', 'in-transit', 'fulfilled', 'error')),
      tracking_number TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      order_id INTEGER NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      sku TEXT NOT NULL,
      PRIMARY KEY (order_id, position),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_order_context (
      conversation_id TEXT PRIMARY KEY,
      normalized_order_number TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (normalized_order_number)
        REFERENCES orders(normalized_order_number) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS promotion_grants (
      conversation_id TEXT NOT NULL,
      pacific_date TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, pacific_date),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS messages_conversation_position
      ON messages(conversation_id, position);
    CREATE INDEX IF NOT EXISTS orders_lookup
      ON orders(normalized_email, normalized_order_number);
  `);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOrderNumber(orderNumber: string): string {
  const compact = orderNumber.replaceAll(/\s/g, "").toUpperCase();
  return compact.startsWith("#") ? compact : `#${compact}`;
}

function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

function seedFixtures(
  database: Database.Database,
  products: readonly ProductFixture[],
  orders: readonly OrderFixture[],
): void {
  const upsertProduct = database.prepare<[string, string, number, string, string]>(`
    INSERT INTO products (sku, name, inventory, description, tags)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      name = excluded.name,
      inventory = excluded.inventory,
      description = excluded.description,
      tags = excluded.tags
  `);
  const upsertOrder = database.prepare<
    [string, string, string, string, string, OrderStatus, string | null]
  >(`
    INSERT INTO orders (
      customer_name,
      email,
      normalized_email,
      order_number,
      normalized_order_number,
      status,
      tracking_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_order_number) DO UPDATE SET
      customer_name = excluded.customer_name,
      email = excluded.email,
      normalized_email = excluded.normalized_email,
      order_number = excluded.order_number,
      status = excluded.status,
      tracking_number = excluded.tracking_number
  `);
  const findOrder = database.prepare<[string], { id: number }>(`
    SELECT id FROM orders WHERE normalized_order_number = ?
  `);
  const deleteOrderItems = database.prepare<[number]>(`
    DELETE FROM order_items WHERE order_id = ?
  `);
  const insertOrderItem = database.prepare<[number, number, string]>(`
    INSERT INTO order_items (order_id, position, sku) VALUES (?, ?, ?)
  `);

  database.transaction(() => {
    for (const product of products) {
      upsertProduct.run(
        normalizeSku(product.SKU),
        product.ProductName.trim(),
        product.Inventory,
        product.Description.trim(),
        JSON.stringify(product.Tags),
      );
    }

    database.prepare("INSERT INTO products_fts(products_fts) VALUES ('rebuild')").run();

    for (const order of orders) {
      const normalizedOrderNumber = normalizeOrderNumber(order.OrderNumber);
      upsertOrder.run(
        order.CustomerName.trim(),
        order.Email.trim(),
        normalizeEmail(order.Email),
        order.OrderNumber.trim(),
        normalizedOrderNumber,
        order.Status,
        order.TrackingNumber,
      );

      const storedOrder = findOrder.get(normalizedOrderNumber);
      if (storedOrder === undefined) {
        throw new Error(`Seeded order ${normalizedOrderNumber} could not be read back`);
      }

      deleteOrderItems.run(storedOrder.id);
      order.ProductsOrdered.forEach((sku, position) => {
        insertOrderItem.run(storedOrder.id, position, normalizeSku(sku));
      });
    }
  }).immediate();
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function parseTags(json: string): readonly string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw new Error("Stored product tags are invalid");
  }
  return value;
}

function toProductCard(row: ProductRow): ProductCard {
  return {
    sku: row.sku,
    name: row.name,
    inventory: row.inventory,
    tags: parseTags(row.tags),
    description: summarizeProductDescription(row.description),
  };
}

function safeFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (tokens === null) {
    return null;
  }
  const terms = tokens
    .filter((token) => !SEARCH_STOP_WORDS.has(token.toLocaleLowerCase("en-US")))
    .slice(0, 8);
  return terms.length === 0 ? null : terms.map((token) => `"${token}"`).join(" OR ");
}

function productLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return MAX_PRODUCT_RESULTS;
  }
  return Math.max(0, Math.min(MAX_PRODUCT_RESULTS, Math.trunc(limit)));
}

function pacificClock(now: Date): PacificClock {
  const parts = new Map(
    pacificFormatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error("Pacific time could not be formatted");
  }
  return {
    date: `${year}-${month}-${day}`,
    minuteOfDay: Number(hour) * 60 + Number(minute),
  };
}

function promotionCode(): string {
  return `SIERRA10-${randomBytes(5).toString("hex").toUpperCase()}`;
}

class SqliteSierraStore implements SierraStore {
  readonly #database: Database.Database;
  #closed = false;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  createConversation(): Conversation {
    const id = randomUUID();
    this.#database
      .prepare<[string, string]>("INSERT INTO conversations (id, created_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    return { id, messages: [], pendingUserMessageId: null };
  }

  getConversation(id: string): Conversation | null {
    const conversation = this.#database
      .prepare<[string], { id: string }>("SELECT id FROM conversations WHERE id = ?")
      .get(id);
    if (conversation === undefined) {
      return null;
    }

    const messages = this.#database
      .prepare<[string], MessageRow>(`
        SELECT id, role, content, created_at, position
        FROM messages
        WHERE conversation_id = ?
        ORDER BY position ASC
      `)
      .all(id)
      .map(toChatMessage);
    const pending = this.#database
      .prepare<[string], { source_message_id: string }>(`
        SELECT source_message_id FROM pending_replies WHERE conversation_id = ?
      `)
      .get(id);
    return {
      id: conversation.id,
      messages,
      pendingUserMessageId: pending?.source_message_id ?? null,
    };
  }

  prepareNewTurn(input: Readonly<{ conversationId: string; content: string }>): PrepareTurnResult {
    return this.#database.transaction((): PrepareTurnResult => {
      const conversation = this.#database
        .prepare<[string], { id: string }>("SELECT id FROM conversations WHERE id = ?")
        .get(input.conversationId);
      if (conversation === undefined) {
        return { kind: "rejected", rejection: { kind: "conversation_not_found" } };
      }

      const pending = this.#database
        .prepare<[string], { source_message_id: string }>(`
          SELECT source_message_id FROM pending_replies WHERE conversation_id = ?
        `)
        .get(input.conversationId);
      if (pending !== undefined) {
        return { kind: "rejected", rejection: { kind: "pending_message_exists" } };
      }

      const next = this.#database
        .prepare<[string], { position: number }>(`
          SELECT COALESCE(MAX(position), -1) + 1 AS position
          FROM messages
          WHERE conversation_id = ?
        `)
        .get(input.conversationId);
      if (next === undefined) {
        throw new Error("Next message position could not be calculated");
      }

      const source: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      this.#database
        .prepare<[string, string, string, string, number]>(`
          INSERT INTO messages (id, conversation_id, role, content, created_at, position)
          VALUES (?, ?, 'user', ?, ?, ?)
        `)
        .run(source.id, input.conversationId, source.content, source.createdAt, next.position);
      this.#database
        .prepare<[string, string]>(`
          INSERT INTO pending_replies (conversation_id, source_message_id) VALUES (?, ?)
        `)
        .run(input.conversationId, source.id);

      return {
        kind: "ready",
        turn: {
          source,
          history: this.#completedHistory(input.conversationId, next.position),
        },
      };
    }).immediate();
  }

  prepareRetry(conversationId: string): PrepareTurnResult {
    return this.#database.transaction((): PrepareTurnResult => {
      const conversation = this.#database
        .prepare<[string], { id: string }>("SELECT id FROM conversations WHERE id = ?")
        .get(conversationId);
      if (conversation === undefined) {
        return { kind: "rejected", rejection: { kind: "conversation_not_found" } };
      }

      const pending = this.#database
        .prepare<[string], PendingRow>(`
          SELECT p.conversation_id, p.source_message_id, m.position
          FROM pending_replies p
          JOIN messages m ON m.id = p.source_message_id
          WHERE p.conversation_id = ?
        `)
        .get(conversationId);
      if (pending === undefined) {
        return { kind: "rejected", rejection: { kind: "no_pending_message" } };
      }

      const sourceRow = this.#database
        .prepare<[string], MessageRow>(`
          SELECT id, role, content, created_at, position FROM messages WHERE id = ?
        `)
        .get(pending.source_message_id);
      if (sourceRow === undefined || sourceRow.role !== "user") {
        throw new Error("Pending reply does not point to a user message");
      }
      return {
        kind: "ready",
        turn: {
          source: toChatMessage(sourceRow),
          history: this.#completedHistory(conversationId, pending.position),
        },
      };
    })();
  }

  completeTurn(input: Readonly<{ sourceMessageId: string; content: string }>): ChatMessage {
    return this.#database.transaction((): ChatMessage => {
      const pending = this.#database
        .prepare<[string], PendingRow>(`
          SELECT p.conversation_id, p.source_message_id, m.position
          FROM pending_replies p
          JOIN messages m ON m.id = p.source_message_id
          WHERE p.source_message_id = ?
        `)
        .get(input.sourceMessageId);
      if (pending === undefined) {
        throw new Error("No pending reply exists for the source message");
      }

      const assistant: ChatMessage = {
        id: randomUUID(),
        role: "assistant",
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      this.#database
        .prepare<[string, string, string, string, number]>(`
          INSERT INTO messages (id, conversation_id, role, content, created_at, position)
          VALUES (?, ?, 'assistant', ?, ?, ?)
        `)
        .run(
          assistant.id,
          pending.conversation_id,
          assistant.content,
          assistant.createdAt,
          pending.position + 1,
        );
      const cleared = this.#database
        .prepare<[string]>("DELETE FROM pending_replies WHERE source_message_id = ?")
        .run(input.sourceMessageId);
      if (cleared.changes !== 1) {
        throw new Error("Pending reply could not be cleared");
      }
      return assistant;
    }).immediate();
  }

  lookupOrder(input: Readonly<{ email: string; orderNumber: string }>): OrderLookupResult {
    const order = this.#database
      .prepare<[string, string], OrderRow>(`
        SELECT id, order_number, status, tracking_number
        FROM orders
        WHERE normalized_email = ? AND normalized_order_number = ?
      `)
      .get(normalizeEmail(input.email), normalizeOrderNumber(input.orderNumber));
    if (order === undefined) {
      return { kind: "not_found" };
    }

    const items = this.#database
      .prepare<[number], OrderItemRow>(`
        SELECT oi.sku, p.name AS product_name
        FROM order_items oi
        LEFT JOIN products p ON p.sku = oi.sku
        WHERE oi.order_id = ?
        ORDER BY oi.position ASC
      `)
      .all(order.id)
      .map((item) => ({ sku: item.sku, productName: item.product_name }));
    const tracking: TrackingInfo =
      order.tracking_number === null
        ? { kind: "untracked" }
        : {
            kind: "tracked",
            number: order.tracking_number,
            url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(order.tracking_number)}`,
          };
    return {
      kind: "found",
      orderNumber: order.order_number,
      status: order.status,
      statusSentence: statusSentences[order.status],
      tracking,
      items,
    };
  }

  rememberOrderForConversation(input: Readonly<{
    conversationId: string;
    orderNumber: string;
  }>): void {
    this.#database
      .prepare<[string, string]>(`
        INSERT INTO conversation_order_context (conversation_id, normalized_order_number)
        VALUES (?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          normalized_order_number = excluded.normalized_order_number
      `)
      .run(input.conversationId, normalizeOrderNumber(input.orderNumber));
  }

  getRememberedOrderProductSkus(conversationId: string): readonly string[] {
    return this.#database
      .prepare<[string], OrderContextItemRow>(`
        SELECT oi.sku
        FROM conversation_order_context context
        JOIN orders o ON o.normalized_order_number = context.normalized_order_number
        JOIN order_items oi ON oi.order_id = o.id
        WHERE context.conversation_id = ?
        ORDER BY oi.position ASC
      `)
      .all(conversationId)
      .map((item) => item.sku);
  }

  searchProducts(input: Readonly<{
    query: string;
    limit: number;
    excludeSkus: readonly string[];
  }>): ProductSearchResult {
    const limit = productLimit(input.limit);
    if (limit === 0) {
      return { kind: "matches", query: input.query, products: [] };
    }

    const exact = this.#database
      .prepare<[string], ProductRow>(`
        SELECT sku, name, inventory, description, tags FROM products WHERE sku = ?
      `)
      .get(normalizeSku(input.query));
    const excludedSkus = new Set(input.excludeSkus.map(normalizeSku));
    if (exact !== undefined) {
      if (excludedSkus.has(exact.sku)) {
        return { kind: "matches", query: input.query, products: [] };
      }
      return { kind: "matches", query: input.query, products: [toProductCard(exact)] };
    }

    const ftsQuery = safeFtsQuery(input.query);
    if (ftsQuery === null) {
      return { kind: "matches", query: input.query, products: [] };
    }
    const products = this.#database
      .prepare<[string, string, number], ProductRow>(`
        SELECT p.sku, p.name, p.inventory, p.description, p.tags
        FROM products_fts
        JOIN products p ON p.id = products_fts.rowid
        WHERE products_fts MATCH ?
          AND p.sku NOT IN (SELECT value FROM json_each(?))
        ORDER BY bm25(products_fts, 0.0, 8.0, 3.0, 0.5) ASC, p.sku ASC
        LIMIT ?
      `)
      .all(ftsQuery, JSON.stringify([...excludedSkus]), limit)
      .map(toProductCard);
    return { kind: "matches", query: input.query, products };
  }

  claimPromotion(input: Readonly<{ conversationId: string; now: Date }>): PromotionResult {
    const clock = pacificClock(input.now);
    return this.#database.transaction((): PromotionResult => {
      const existing = this.#database
        .prepare<[string, string], PromotionGrantRow>(`
          SELECT code
          FROM promotion_grants
          WHERE conversation_id = ? AND pacific_date = ?
        `)
        .get(input.conversationId, clock.date);
      if (existing !== undefined) {
        return {
          kind: "granted",
          code: existing.code,
          percentOff: 10,
          alreadyGranted: true,
          pacificDate: clock.date,
        };
      }
      if (clock.minuteOfDay < 8 * 60) {
        return { kind: "outside_window", window: PROMOTION_WINDOW, timing: "before" };
      }
      if (clock.minuteOfDay >= 10 * 60) {
        return { kind: "outside_window", window: PROMOTION_WINDOW, timing: "after" };
      }

      const code = promotionCode();
      this.#database
        .prepare<[string, string, string, string]>(`
          INSERT INTO promotion_grants (conversation_id, pacific_date, code, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(input.conversationId, clock.date, code, input.now.toISOString());
      return {
        kind: "granted",
        code,
        percentOff: 10,
        alreadyGranted: false,
        pacificDate: clock.date,
      };
    }).immediate();
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  #completedHistory(conversationId: string, beforePosition: number): readonly ChatMessage[] {
    return this.#database
      .prepare<[string, number, number], MessageRow>(`
        SELECT id, role, content, created_at, position
        FROM messages
        WHERE conversation_id = ? AND position < ?
        ORDER BY position DESC
        LIMIT ?
      `)
      .all(conversationId, beforePosition, MAX_HISTORY_MESSAGES)
      .reverse()
      .map(toChatMessage);
  }
}

export function openSierraStore(options: OpenSierraStoreOptions): SierraStore {
  const products = readProductFixtures(options.productsPath);
  const orders = readOrderFixtures(options.ordersPath);

  if (options.databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
  }

  const database = new Database(options.databasePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    createSchema(database);
    seedFixtures(database, products, orders);
    return new SqliteSierraStore(database);
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}
