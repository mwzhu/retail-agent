import OpenAI from "openai";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { z } from "zod";
import {
  ModelClientError,
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
} from "./types";
import { hasExplicitPromotionIntent } from "./intents";

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "lookup_order",
      description:
        "Look up one order after the customer has supplied both their email and order number.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "The customer's email address." },
          orderNumber: {
            type: "string",
            description: "The customer's complete order number.",
          },
        },
        required: ["email", "orderNumber"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search the Sierra Outfitters catalog for grounded recommendations or product facts.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A concise catalog search query based on the customer's request.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_early_risers",
      description:
        "Claim the Early Risers promotion. Use only when the customer explicitly asks to claim or receive it.",
      strict: true,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
] satisfies ChatCompletionTool[];

const rawToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    id: z.string().min(1),
    name: z.literal("lookup_order"),
    input: z
      .object({ email: z.string().min(1), orderNumber: z.string().min(1) })
      .strict(),
  }),
  z.object({
    id: z.string().min(1),
    name: z.literal("search_products"),
    input: z.object({ query: z.string().min(1) }).strict(),
  }),
  z.object({
    id: z.string().min(1),
    name: z.literal("claim_early_risers"),
    input: z.object({}).strict(),
  }),
]);

export function createOpenAIModelClient(input: Readonly<{
  apiKey: string;
  model: string;
}>): ModelClient {
  const client = new OpenAI({ apiKey: input.apiKey });

  return {
    plan: async (request) => {
      try {
        const completion = await client.chat.completions.create(
          {
            model: input.model,
            messages: request.messages.map(toOpenAIMessage),
            tools: TOOL_DEFINITIONS,
            tool_choice: requiredToolChoice(request.messages),
            parallel_tool_calls: false,
            temperature: 0,
            store: false,
          },
          { signal: request.signal },
        );
        const choice = completion.choices.at(0);
        if (choice === undefined) {
          throw new ModelClientError("INTERNAL", "The model returned no choices.");
        }

        const calls = (choice.message.tool_calls ?? []).map(parseToolCall);
        return { content: choice.message.content, calls };
      } catch (error) {
        throw toModelClientError(error);
      }
    },
    streamFinal: async function* (request) {
      try {
        const stream = await client.chat.completions.create(
          {
            model: input.model,
            messages: request.messages.map(toOpenAIMessage),
            stream: true,
            temperature: 0,
            store: false,
          },
          { signal: request.signal },
        );

        for await (const chunk of stream) {
          const text = chunk.choices.at(0)?.delta.content;
          if (typeof text === "string" && text.length > 0) {
            yield text;
          }
        }
      } catch (error) {
        throw toModelClientError(error);
      }
    },
  };
}

export function selectToolChoice(
  messages: readonly ModelMessage[],
): "lookup_order" | "search_products" | "claim_early_risers" | "auto" | "none" {
  const userMessages = messages.filter(
    (message): message is Extract<ModelMessage, { kind: "text" }> =>
      message.kind === "text" && message.role === "user",
  );
  const currentRequest = userMessages.at(-1)?.content;
  if (currentRequest === undefined) return "none";

  const userContext = userMessages
    .map((message) => message.content)
    .join("\n");
  const completedTools = new Set(
    messages
      .filter((message) => message.kind === "tool_result")
      .map((message) => message.name),
  );
  const orderNumberPattern = /(?:#\s*)?[A-Z](?:\s*\d){3,}\b/i;
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(userContext);
  const hasOrderNumber = orderNumberPattern.test(userContext);
  const orderIntent = /\b(?:order|track|tracking)\b/i.test(currentRequest)
    || (hasEmail && orderNumberPattern.test(currentRequest));
  if (
    orderIntent
    && hasEmail
    && hasOrderNumber
    && !completedTools.has("lookup_order")
  ) {
    return "lookup_order";
  }

  const productIntent = /\b(?:recommend|product|catalog|gear|equipment|buy|price|cost|inventory|stock|carry|return|warranty|backpack|skis?|jetpack|cloak|lampshade|crampons)\b|\bSO[A-Z0-9]{5}\b/i;
  if (productIntent.test(currentRequest) && !completedTools.has("search_products")) {
    return "search_products";
  }

  const promotionIntent = hasExplicitPromotionIntent(currentRequest);
  if (promotionIntent && !completedTools.has("claim_early_risers")) {
    return "claim_early_risers";
  }

  const handledIntent = (orderIntent && completedTools.has("lookup_order"))
    || (productIntent.test(currentRequest) && completedTools.has("search_products"))
    || (/\bearly\s+risers\b/i.test(currentRequest) && (!promotionIntent || completedTools.has("claim_early_risers")));
  if (handledIntent) return "none";

  return "auto";
}

function requiredToolChoice(messages: readonly ModelMessage[]) {
  const name = selectToolChoice(messages);
  return name === "auto" || name === "none"
    ? name
    : { type: "function" as const, function: { name } };
}

function toOpenAIMessage(message: ModelMessage): ChatCompletionMessageParam {
  switch (message.kind) {
    case "text":
      return { role: message.role, content: message.content };
    case "tool_calls":
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.calls.map(toOpenAIToolCall),
      };
    case "tool_result":
      return {
        role: "tool",
        tool_call_id: message.callId,
        content: message.content,
      };
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function toOpenAIToolCall(call: ModelToolCall): ChatCompletionMessageFunctionToolCall {
  switch (call.kind) {
    case "lookup_order":
      return {
        id: call.id,
        type: "function",
        function: {
          name: call.kind,
          arguments: JSON.stringify({
            email: call.email,
            orderNumber: call.orderNumber,
          }),
        },
      };
    case "search_products":
      return {
        id: call.id,
        type: "function",
        function: {
          name: call.kind,
          arguments: JSON.stringify({ query: call.query }),
        },
      };
    case "claim_early_risers":
      return {
        id: call.id,
        type: "function",
        function: { name: call.kind, arguments: "{}" },
      };
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

function parseToolCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): ModelToolCall {
  if (call.type !== "function") {
    throw new ModelClientError("INTERNAL", "The model requested an unsupported tool type.");
  }

  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments);
  } catch (error) {
    throw new ModelClientError("INTERNAL", "The model returned invalid tool arguments.", {
      cause: error,
    });
  }

  const parsed = rawToolCallSchema.safeParse({
    id: call.id,
    name: call.function.name,
    input,
  });
  if (!parsed.success) {
    throw new ModelClientError("INTERNAL", "The model returned invalid tool arguments.", {
      cause: parsed.error,
    });
  }

  switch (parsed.data.name) {
    case "lookup_order":
      return {
        kind: parsed.data.name,
        id: parsed.data.id,
        email: parsed.data.input.email,
        orderNumber: parsed.data.input.orderNumber,
      };
    case "search_products":
      return {
        kind: parsed.data.name,
        id: parsed.data.id,
        query: parsed.data.input.query,
      };
    case "claim_early_risers":
      return { kind: parsed.data.name, id: parsed.data.id };
    default: {
      const exhaustive: never = parsed.data;
      return exhaustive;
    }
  }
}

function toModelClientError(error: unknown): ModelClientError {
  if (error instanceof ModelClientError) {
    return error;
  }
  if (error instanceof Error && /timeout/i.test(error.name)) {
    return new ModelClientError("MODEL_TIMEOUT", "The model request timed out.", {
      cause: error,
    });
  }
  return new ModelClientError("MODEL_UNAVAILABLE", "The model request failed.", {
    cause: error,
  });
}
