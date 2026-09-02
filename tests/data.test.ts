import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PrepareTurnResult, SierraStore } from "../src/server/contracts";
import { openSierraStore } from "../src/server/data/store";

const productsPath = resolve("ProductCatalog.json");
const ordersPath = resolve("CustomerOrders.json");
const openStores: SierraStore[] = [];
const temporaryDirectories: string[] = [];

function openStore(databasePath = ":memory:"): SierraStore {
  const store = openSierraStore({ databasePath, ordersPath, productsPath });
  openStores.push(store);
  return store;
}

function readyTurn(result: PrepareTurnResult) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") {
    throw new Error(`Expected a ready turn, received ${result.rejection.kind}`);
  }
  return result.turn;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Sierra data store", () => {
  it("seeds the product and order fixtures", () => {
    const store = openStore();

    const products = store.searchProducts({ query: "SOBP001", limit: 5, excludeSkus: [] });
    expect(products.products).toHaveLength(1);
    expect(products.products[0]).toMatchObject({
      sku: "SOBP001",
      name: "Bhavish's Backcountry Blaze Backpack",
      inventory: 120,
    });
    expect(products.products[0]?.description.length).toBeLessThanOrEqual(240);

    const hairbrush = store.searchProducts({ query: "SOBT003", limit: 5, excludeSkus: [] });
    expect(hairbrush.products[0]?.description).toContain("shine to your locks");

    const order = store.lookupOrder({
      email: "john.doe@example.com",
      orderNumber: "#W001",
    });
    expect(order.kind).toBe("found");
    if (order.kind === "found") {
      expect(order.items.map((item) => item.sku)).toEqual(["SOBP001", "SOWB004"]);
    }
  });

  it("stems safe whole-token searches so skiing finds skis", () => {
    const store = openStore();

    const result = store.searchProducts({ query: "skiing", limit: 5, excludeSkus: [] });

    expect(result.products.map((product) => product.sku)).toContain("SOTN002");
    expect(() => store.searchProducts({
      query: `" OR *`,
      limit: 5,
      excludeSkus: [],
    })).not.toThrow();
    expect(store.searchProducts({
      query: `I pasted this into search: " OR * ) ( NEAR/1? Do you carry anything matching it?`,
      limit: 5,
      excludeSkus: [],
    }).products).toEqual([]);
  });

  it("caps caller-requested product results at five", () => {
    const store = openStore();

    const result = store.searchProducts({ query: "adventure", limit: 1_000, excludeSkus: [] });

    expect(result.products).toHaveLength(5);
  });

  it("persists verified order context and excludes its purchased SKUs", () => {
    const directory = mkdtempSync(join(tmpdir(), "sierra-order-context-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sierra.sqlite");
    const store = openStore(databasePath);
    const conversation = store.createConversation();
    const order = store.lookupOrder({
      email: "john.doe@example.com",
      orderNumber: "W001",
    });
    expect(order.kind).toBe("found");
    store.rememberOrderForConversation({
      conversationId: conversation.id,
      orderNumber: "W001",
    });

    const reopened = openStore(databasePath);
    expect(reopened.getRememberedOrderProductSkus(conversation.id)).toEqual([
      "SOBP001",
      "SOWB004",
    ]);
    const products = reopened.searchProducts({
      query: "adventure",
      limit: 5,
      excludeSkus: reopened.getRememberedOrderProductSkus(conversation.id),
    });
    expect(products.products.map((product) => product.sku)).not.toContain("SOBP001");
    expect(products.products.map((product) => product.sku)).not.toContain("SOWB004");
  });

  it("requires the normalized email and order number together", () => {
    const store = openStore();

    expect(
      store.lookupOrder({ email: "  JOHN.DOE@EXAMPLE.COM ", orderNumber: " w001 " }).kind,
    ).toBe("found");
    expect(
      store.lookupOrder({ email: "jane.smith@example.com", orderNumber: "#W001" }),
    ).toEqual({ kind: "not_found" });
    expect(
      store.lookupOrder({ email: "john.doe@example.com", orderNumber: "#W002" }),
    ).toEqual({ kind: "not_found" });
  });

  it("does not construct a tracking URL for null tracking", () => {
    const store = openStore();

    const result = store.lookupOrder({
      email: "alice.johnson@example.com",
      orderNumber: "#W003",
    });

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tracking).toEqual({ kind: "untracked" });
      expect(result.tracking).not.toHaveProperty("url");
    }
  });

  it("keeps missing product SKUs and does not invent support action", () => {
    const store = openStore();

    const result = store.lookupOrder({
      email: "bob.brown@example.com",
      orderNumber: "#W004",
    });

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.items).toContainEqual({ sku: "SOCH010", productName: null });
      expect(result.statusSentence).not.toMatch(/support|contact|call|email/i);
    }
  });

  it("uses inclusive 08:00 and exclusive 10:00 Pacific promotion boundaries", () => {
    const store = openStore();
    const before = store.createConversation();
    const atOpen = store.createConversation();
    const beforeClose = store.createConversation();
    const atClose = store.createConversation();

    expect(
      store.claimPromotion({
        conversationId: before.id,
        now: new Date("2026-08-31T14:59:59.000Z"),
      }),
    ).toMatchObject({ kind: "outside_window", timing: "before" });
    expect(
      store.claimPromotion({
        conversationId: atOpen.id,
        now: new Date("2026-08-31T15:00:00.000Z"),
      }),
    ).toMatchObject({ kind: "granted", pacificDate: "2026-08-31" });
    expect(
      store.claimPromotion({
        conversationId: beforeClose.id,
        now: new Date("2026-08-31T16:59:59.999Z"),
      }),
    ).toMatchObject({ kind: "granted", pacificDate: "2026-08-31" });
    expect(
      store.claimPromotion({
        conversationId: atClose.id,
        now: new Date("2026-08-31T17:00:00.000Z"),
      }),
    ).toMatchObject({ kind: "outside_window", timing: "after" });
  });

  it("returns the same promotion grant on repeat claims", () => {
    const store = openStore();
    const conversation = store.createConversation();
    const input = {
      conversationId: conversation.id,
      now: new Date("2026-01-15T16:30:00.000Z"),
    };

    const first = store.claimPromotion(input);
    const repeat = store.claimPromotion(input);

    expect(first).toMatchObject({ kind: "granted", alreadyGranted: false });
    expect(repeat).toMatchObject({ kind: "granted", alreadyGranted: true });
    if (first.kind === "granted" && repeat.kind === "granted") {
      expect(repeat.code).toBe(first.code);
    }
  });

  it("recovers an existing promotion grant after the claim window closes", () => {
    const store = openStore();
    const conversation = store.createConversation();
    const first = store.claimPromotion({
      conversationId: conversation.id,
      now: new Date("2026-08-31T16:59:59.000Z"),
    });
    const recovered = store.claimPromotion({
      conversationId: conversation.id,
      now: new Date("2026-08-31T17:00:00.000Z"),
    });

    expect(first).toMatchObject({ kind: "granted", alreadyGranted: false });
    expect(recovered).toMatchObject({ kind: "granted", alreadyGranted: true });
    if (first.kind === "granted" && recovered.kind === "granted") {
      expect(recovered.code).toBe(first.code);
    }
  });

  it("keeps one durable pending user message for retries", () => {
    const store = openStore();
    const conversation = store.createConversation();
    const first = readyTurn(
      store.prepareNewTurn({ conversationId: conversation.id, content: "Find me skis" }),
    );

    expect(
      store.prepareNewTurn({ conversationId: conversation.id, content: "A second pending turn" }),
    ).toEqual({ kind: "rejected", rejection: { kind: "pending_message_exists" } });

    const retry = readyTurn(store.prepareRetry(conversation.id));
    expect(retry.source).toEqual(first.source);

    const assistant = store.completeTurn({
      sourceMessageId: first.source.id,
      content: "Here are the skis.",
    });
    expect(assistant.role).toBe("assistant");
    expect(store.getConversation(conversation.id)?.pendingUserMessageId).toBeNull();
    expect(store.prepareRetry(conversation.id)).toEqual({
      kind: "rejected",
      rejection: { kind: "no_pending_message" },
    });
  });

  it("caps completed model history at the most recent twenty messages", () => {
    const store = openStore();
    const conversation = store.createConversation();

    for (let index = 0; index < 11; index += 1) {
      const turn = readyTurn(
        store.prepareNewTurn({ conversationId: conversation.id, content: `user ${index}` }),
      );
      store.completeTurn({ sourceMessageId: turn.source.id, content: `assistant ${index}` });
    }

    const latest = readyTurn(
      store.prepareNewTurn({ conversationId: conversation.id, content: "latest" }),
    );
    expect(latest.history).toHaveLength(20);
    expect(latest.history[0]?.content).toBe("user 1");
    expect(latest.history.at(-1)?.content).toBe("assistant 10");
  });

  it("persists conversations and pending retries across re-open", () => {
    const directory = mkdtempSync(join(tmpdir(), "sierra-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nested", "state", "sierra.sqlite");
    const firstStore = openStore(databasePath);
    const conversation = firstStore.createConversation();
    const turn = readyTurn(
      firstStore.prepareNewTurn({ conversationId: conversation.id, content: "Persist this" }),
    );
    firstStore.close();

    expect(existsSync(dirnameOf(databasePath))).toBe(true);
    const reopened = openStore(databasePath);
    expect(reopened.getConversation(conversation.id)?.pendingUserMessageId).toBe(turn.source.id);
    expect(readyTurn(reopened.prepareRetry(conversation.id)).source.id).toBe(turn.source.id);
    reopened.completeTurn({ sourceMessageId: turn.source.id, content: "Persisted" });
    reopened.close();

    const reopenedAgain = openStore(databasePath);
    expect(reopenedAgain.getConversation(conversation.id)?.messages.map((message) => message.content)).toEqual([
      "Persist this",
      "Persisted",
    ]);
  });

  it("re-seeds idempotently on re-open", () => {
    const directory = mkdtempSync(join(tmpdir(), "sierra-seed-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sierra.sqlite");
    openStore(databasePath).close();

    const reopened = openStore(databasePath);
    const order = reopened.lookupOrder({
      email: "john.doe@example.com",
      orderNumber: "#W001",
    });
    const product = reopened.searchProducts({ query: "SOBP001", limit: 5, excludeSkus: [] });

    expect(product.products).toHaveLength(1);
    expect(order.kind).toBe("found");
    if (order.kind === "found") {
      expect(order.items).toHaveLength(2);
    }
  });
});

function dirnameOf(path: string): string {
  return resolve(path, "..");
}
