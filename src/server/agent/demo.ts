import {
  ModelClientError,
  type ModelClient,
  type ModelMessage,
  type ModelPlanningResult,
  type ModelPlanningRequest,
} from "./types";
import { TRAIL_FLOURISHES, TRAIL_SIGNOFF } from "./prompt";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const ORDER_PATTERN = /#[A-Z]\d+\b/i;

export function createDemoModelClient(): ModelClient {
  return {
    plan: async (request) => createDemoPlan(request),
    streamFinal: async function* (request) {
      const response = `${createDemoResponse(request.messages)} ${TRAIL_SIGNOFF}`;
      const splitAt = Math.max(1, Math.floor(response.length / 2));
      yield response.slice(0, splitAt);
      yield response.slice(splitAt);
    },
  };
}

export function createUnavailableModelClient(): ModelClient {
  const unavailable = () =>
    new ModelClientError("MODEL_UNAVAILABLE", "No model API key is configured.");

  return {
    plan: async () => {
      throw unavailable();
    },
    streamFinal: async function* () {
      throw unavailable();
    },
  };
}

function createDemoPlan(request: ModelPlanningRequest): ModelPlanningResult {
  if (request.messages.some((message) => message.kind === "tool_result")) {
    return { content: null, calls: [] };
  }

  const userMessage = findLatestUserMessage(request.messages);
  if (userMessage === null) {
    return { content: null, calls: [] };
  }

  const email = userMessage.match(EMAIL_PATTERN)?.at(0);
  const orderNumber = userMessage.match(ORDER_PATTERN)?.at(0);
  if (email !== undefined && orderNumber !== undefined) {
    return {
      content: null,
      calls: [
        {
          kind: "lookup_order",
          id: "demo-order-1",
          email,
          orderNumber,
        },
      ],
    };
  }

  if (/\bearly\s+risers\b/i.test(userMessage)) {
    return {
      content: null,
      calls: [{ kind: "claim_early_risers", id: "demo-promotion-1" }],
    };
  }

  if (/\b(?:recommend|product|catalog|gear|backpack|ski|outdoor|looking for)\b/i.test(userMessage)) {
    const query = /\bski/i.test(userMessage)
      ? "skiing"
      : /\bbackpack/i.test(userMessage)
        ? "backpack"
        : userMessage;
    return {
      content: null,
      calls: [
        {
          kind: "search_products",
          id: "demo-products-1",
          query,
        },
      ],
    };
  }

  return { content: null, calls: [] };
}

function createDemoResponse(messages: readonly ModelMessage[]): string {
  const toolResult = findLatestToolResult(messages);
  if (toolResult !== null) {
    return formatDemoToolResult(toolResult.content);
  }

  const userMessage = findLatestUserMessage(messages) ?? "";
  if (/\border|tracking|track\b/i.test(userMessage)) {
    return `Please share both the email address and order number used for the order. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }
  if (/\bearly\s+risers\b/i.test(userMessage)) {
    return `Please explicitly ask to receive the Early Risers promotion, and I can check the Pacific-time window. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }
  return `How can I help with an order, product recommendation, or the Early Risers promotion? ${TRAIL_FLOURISHES.onwardIntoTheUnknown}`;
}

function findLatestUserMessage(messages: readonly ModelMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.kind === "text" && message.role === "user") {
      return message.content;
    }
  }
  return null;
}

function findLatestToolResult(
  messages: readonly ModelMessage[],
): Extract<ModelMessage, { kind: "tool_result" }> | null {
  for (const message of messages.toReversed()) {
    if (message.kind === "tool_result") {
      return message;
    }
  }
  return null;
}

function formatDemoToolResult(content: string): string {
  const parsed = parseRecord(content);
  if (parsed === null || typeof parsed.kind !== "string") {
    return `I could not read the verified result. Please retry. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }

  switch (parsed.kind) {
    case "not_found":
      return `I could not find an order matching that email and order number. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
    case "found":
      return formatFoundOrder(parsed);
    case "matches":
      return formatProductMatches(parsed);
    case "not_explicit":
      return `Please explicitly ask to receive the Early Risers promotion before I claim it. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
    case "outside_window":
      return `The Early Risers promotion is available from 8:00 to 10:00 AM Pacific. It is outside that window now. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
    case "granted":
      return typeof parsed.code === "string"
        ? `Your 10% Early Risers code is ${parsed.code}. ${TRAIL_FLOURISHES.adventureAwaits}`
        : `I could not read the verified promotion code. Please retry. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
    default:
      return `I could not read the verified result. Please retry. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }
}

function formatFoundOrder(order: Record<string, unknown>): string {
  if (typeof order.statusSentence !== "string") {
    return `I could not read the verified order status. Please retry. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }
  const tracking = order.tracking;
  if (isRecord(tracking) && tracking.kind === "tracked" && typeof tracking.url === "string") {
    return `${order.statusSentence} Track it here: ${tracking.url} ${TRAIL_FLOURISHES.onwardIntoTheUnknown}`;
  }
  return `${order.statusSentence} No tracking link is available. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
}

function formatProductMatches(result: Record<string, unknown>): string {
  if (!Array.isArray(result.products) || result.products.length === 0) {
    return `I did not find a matching catalog product. Try a different description. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
  }

  const names = result.products.flatMap((product) => {
    if (!isRecord(product) || typeof product.name !== "string") {
      return [];
    }
    return [product.name];
  });
  return names.length > 0
    ? `Catalog matches: ${names.join(", ")}. ${TRAIL_FLOURISHES.happyTrails}`
    : `I could not read the verified catalog matches. Please retry. ${TRAIL_FLOURISHES.takeCareOnTheTrail}`;
}

function parseRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
