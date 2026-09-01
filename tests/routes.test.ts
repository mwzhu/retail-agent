import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChatApplication,
  createDemoModelClient,
  ModelClientError,
  type ModelClient,
} from "../src/server/agent";
import { openSierraStore } from "../src/server/data/store";
import { registerRoutes } from "../src/server/routes";
import { chatStreamEventSchema, type ChatStreamEvent } from "../src/shared/protocol";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function events(body: string): ChatStreamEvent[] {
  return body
    .trim()
    .split("\n")
    .map((line) => chatStreamEventSchema.parse(JSON.parse(line)));
}

async function testApp(model: ModelClient) {
  const store = openSierraStore({
    databasePath: ":memory:",
    ordersPath: "CustomerOrders.json",
    productsPath: "ProductCatalog.json",
  });
  const app = Fastify();
  openApps.push(app);
  await registerRoutes(app, {
    chat: createChatApplication({ store, model }),
    mode: "demo",
  });
  app.addHook("onClose", async () => store.close());
  return app;
}

describe("chat routes", () => {
  it("streams a complete turn and reloads its persisted transcript", async () => {
    const app = await testApp(createDemoModelClient());
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "Recommend gear for skiing" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    const streamed = events(response.body);
    expect(streamed.at(0)?.type).toBe("turn.accepted");
    expect(streamed.filter((event) => event.type === "assistant.delta").length).toBeGreaterThan(0);
    expect(streamed.at(-1)?.type).toBe("turn.completed");

    const accepted = streamed.at(0);
    if (accepted?.type !== "turn.accepted") throw new Error("Missing accepted event");
    const stored = await app.inject({
      method: "GET",
      url: `/api/conversations/${accepted.conversationId}`,
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({
      id: accepted.conversationId,
      pendingUserMessageId: null,
      messages: [
        { role: "user", content: "Recommend gear for skiing" },
        { role: "assistant" },
      ],
    });
  });

  it("keeps a failed user message and completes it through retry", async () => {
    let planningAttempt = 0;
    const model: ModelClient = {
      selectTools: async () => {
        planningAttempt += 1;
        if (planningAttempt === 1) {
          throw new ModelClientError("MODEL_UNAVAILABLE", "temporary provider failure");
        }
        return { content: null, calls: [] };
      },
      planIntents: async () => ({
        kind: "accepted",
        plan: {
          order: { state: "none" },
          product: { state: "none" },
          promotion: { state: "none" },
        },
      }),
      streamFinal: async function* () {
        yield "Recovered on retry. 🏔️";
      },
    };
    const app = await testApp(model);
    const failedResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "Help me" },
    });
    const failedEvents = events(failedResponse.body);
    const accepted = failedEvents.at(0);
    if (accepted?.type !== "turn.accepted") throw new Error("Missing accepted event");
    expect(failedEvents.at(-1)?.type).toBe("turn.failed");

    const pending = await app.inject({
      method: "GET",
      url: `/api/conversations/${accepted.conversationId}`,
    });
    expect(pending.json()).toMatchObject({
      pendingUserMessageId: accepted.userMessage.id,
      messages: [{ role: "user", content: "Help me" }],
    });

    const retried = await app.inject({
      method: "POST",
      url: "/api/chat/retry",
      payload: { conversationId: accepted.conversationId },
    });
    expect(events(retried.body).at(-1)?.type).toBe("turn.completed");

    const completed = await app.inject({
      method: "GET",
      url: `/api/conversations/${accepted.conversationId}`,
    });
    expect(completed.json()).toMatchObject({
      pendingUserMessageId: null,
      messages: [
        { role: "user", content: "Help me" },
        { role: "assistant", content: "Recovered on retry. 🏔️" },
      ],
    });
  });

  it("rejects invalid chat payloads before creating a conversation", async () => {
    const app = await testApp(createDemoModelClient());

    for (const payload of [
      { message: "   " },
      { message: "x".repeat(4_001) },
      { message: 42 },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/chat", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
      expect(response.headers["content-type"]).not.toContain("application/x-ndjson");
    }
  });

  it("returns bounded errors for missing conversations and invalid retries", async () => {
    const app = await testApp(createDemoModelClient());
    const missing = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId: "missing", message: "Hello" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "conversation_not_found" });

    const completed = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "Hello" },
    });
    const accepted = events(completed.body).at(0);
    if (accepted?.type !== "turn.accepted") throw new Error("Missing accepted event");
    const retry = await app.inject({
      method: "POST",
      url: "/api/chat/retry",
      payload: { conversationId: accepted.conversationId },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: "no_pending_message" });
  });
});
