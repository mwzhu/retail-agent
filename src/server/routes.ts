import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChatApplication, OpenTurnResult, TurnCommand } from "./agent/index";
import {
  chatRequestSchema,
  retryRequestSchema,
  type ChatStreamEvent,
} from "../shared/protocol";

interface RouteDependencies {
  readonly chat: ChatApplication;
  readonly mode: "demo" | "openai" | "unconfigured";
}

function line(event: ChatStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function rejectTurn(reply: FastifyReply, opened: Extract<OpenTurnResult, { kind: "rejected" }>) {
  const status = opened.reason === "conversation_not_found" ? 404 : 409;
  return reply.code(status).send({ error: opened.reason });
}

async function* turnLines(opened: Extract<OpenTurnResult, { kind: "accepted" }>) {
  yield line({
    type: "turn.accepted",
    conversationId: opened.conversationId,
    userMessage: opened.source,
  });

  let step = await opened.output.next();
  while (!step.done) {
    yield line({ type: "assistant.delta", text: step.value.text });
    step = await opened.output.next();
  }

  const terminal = step.value;
  if (terminal.kind === "completed") {
    yield line({ type: "turn.completed", assistantMessage: terminal.assistant });
    return;
  }

  if (terminal.kind === "failed") {
    yield line({
      type: "turn.failed",
      code: terminal.code,
      message: terminal.message,
      retryable: terminal.retryable,
    });
  }
}

async function sendTurn(
  reply: FastifyReply,
  opened: OpenTurnResult,
): Promise<FastifyReply> {
  if (opened.kind === "rejected") return rejectTurn(reply, opened);

  reply.headers({
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  return reply.send(Readable.from(turnLines(opened)));
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, mode: dependencies.mode }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = dependencies.chat.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    return conversation;
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const conversationId = parsed.data.conversationId
      ?? dependencies.chat.createConversation().id;
    const command: TurnCommand = {
      kind: "new",
      conversationId,
      content: parsed.data.message,
    };
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const opened = await dependencies.chat.openTurn(command, controller.signal);
    return sendTurn(reply, opened);
  });

  app.post("/api/chat/retry", async (request, reply) => {
    const parsed = retryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const command: TurnCommand = {
      kind: "retry",
      conversationId: parsed.data.conversationId,
    };
    const opened = await dependencies.chat.openTurn(command, controller.signal);
    return sendTurn(reply, opened);
  });
}
