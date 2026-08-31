import {
  chatStreamEventSchema,
  conversationSchema,
  type ChatMessage,
  type Conversation,
  type TurnErrorCode,
} from "../shared/protocol";

const MAX_LINE_BYTES = 64 * 1024;

export type StreamResult =
  | Readonly<{ kind: "completed"; conversationId: string }>
  | Readonly<{
      kind: "failed";
      conversationId: string | null;
      code: TurnErrorCode;
      message: string;
    }>;

interface StreamCallbacks {
  readonly onAccepted: (conversationId: string, userMessage: ChatMessage) => void;
  readonly onDelta: (text: string) => void;
  readonly onCompleted: (assistantMessage: ChatMessage) => void;
}

export interface HealthStatus {
  readonly ok: boolean;
  readonly mode: "demo" | "openai" | "unconfigured" | "offline";
}

function connectionFailure(conversationId: string | null): StreamResult {
  return {
    kind: "failed",
    conversationId,
    code: "CONNECTION_LOST",
    message: "The connection ended before the reply finished. Your message is saved, so you can retry.",
  };
}

export async function streamChat(
  path: "/api/chat" | "/api/chat/retry",
  body: Readonly<Record<string, string>>,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return connectionFailure(null);
  }

  if (!response.ok) {
    return {
      kind: "failed",
      conversationId: null,
      code: "INTERNAL",
      message: response.status === 409
        ? "This conversation already has a message waiting for a reply. Retry that message first."
        : "Sierra Outfitters could not start that request. Try again.",
    };
  }

  if (!response.body) return connectionFailure(null);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let conversationId: string | null = null;
  let terminal = false;
  let result: StreamResult | null = null;

  const consume = (rawLine: string) => {
    if (!rawLine.trim() || terminal) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawLine);
    } catch {
      result = connectionFailure(conversationId);
      terminal = true;
      return;
    }

    const parsed = chatStreamEventSchema.safeParse(decoded);
    if (!parsed.success) {
      result = connectionFailure(conversationId);
      terminal = true;
      return;
    }

    const event = parsed.data;
    switch (event.type) {
      case "turn.accepted":
        conversationId = event.conversationId;
        callbacks.onAccepted(event.conversationId, event.userMessage);
        return;
      case "assistant.delta":
        callbacks.onDelta(event.text);
        return;
      case "turn.completed":
        if (conversationId === null) {
          result = connectionFailure(null);
          terminal = true;
          return;
        }
        callbacks.onCompleted(event.assistantMessage);
        result = { kind: "completed", conversationId };
        terminal = true;
        return;
      case "turn.failed":
        result = {
          kind: "failed",
          conversationId,
          code: event.code,
          message: event.message,
        };
        terminal = true;
    }
  };

  try {
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (encoder.encode(buffer).byteLength > MAX_LINE_BYTES) {
        return connectionFailure(conversationId);
      }

      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0 && !terminal) {
        consume(buffer.slice(0, lineEnd).replace(/\r$/, ""));
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (!terminal && buffer.trim()) consume(buffer);
  } catch {
    return connectionFailure(conversationId);
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  return result ?? connectionFailure(conversationId);
}

export async function fetchConversation(id: string): Promise<Conversation | null> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Conversation request failed");
  return conversationSchema.parse(await response.json());
}

export async function fetchHealth(): Promise<HealthStatus> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return { ok: false, mode: "offline" };
    const body: unknown = await response.json();
    if (
      typeof body === "object"
      && body !== null
      && "ok" in body
      && "mode" in body
      && body.ok === true
      && (body.mode === "demo" || body.mode === "openai" || body.mode === "unconfigured")
    ) {
      return { ok: true, mode: body.mode };
    }
    return { ok: false, mode: "offline" };
  } catch {
    return { ok: false, mode: "offline" };
  }
}
