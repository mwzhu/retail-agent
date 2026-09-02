import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import {
  createIntentPlannerInstruction,
  createToolDefinitions,
  intentPlanJsonSchema,
  parseModelToolCall,
  validateIntentPlan,
  type ModelToolCall,
  type ToolSpecVersion,
} from "./capabilities";
import {
  ModelClientError,
  type ModelClient,
  type ModelMessage,
  type ToolDirective,
} from "./types";

export function createOpenAIModelClient(input: Readonly<{
  apiKey: string;
  model: string;
  toolSpecVersion: ToolSpecVersion;
}>): ModelClient {
  const client = new OpenAI({ apiKey: input.apiKey });
  const tools = createToolDefinitions(input.toolSpecVersion);
  const intentPlannerInstruction = createIntentPlannerInstruction(input.toolSpecVersion);

  return {
    selectTools: async (request) => {
      try {
        const completion = await client.chat.completions.create(
          {
            model: input.model,
            messages: request.messages.map(toOpenAIMessage),
            tools,
            tool_choice: toOpenAIToolChoice(request.directive),
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

        const calls = (choice.message.tool_calls ?? []).map(parseOpenAIToolCall);
        return { content: choice.message.content, calls };
      } catch (error) {
        throw toModelClientError(error);
      }
    },
    planIntents: async (request) => {
      try {
        const completion = await client.chat.completions.parse(
          {
            model: input.model,
            messages: [
              ...request.messages.map(toOpenAIMessage),
              { role: "system", content: intentPlannerInstruction },
            ],
            response_format: zodResponseFormat(intentPlanJsonSchema(), "sierra_intent_plan"),
            temperature: 0,
            store: false,
          },
          { signal: request.signal },
        );
        const choice = completion.choices.at(0);
        if (choice === undefined) {
          throw new ModelClientError("INTERNAL", "The model returned no choices.");
        }
        if (choice.message.refusal !== null) {
          return { kind: "rejected", reason: "provider_refusal" };
        }
        return validateIntentPlan(choice.message.parsed);
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

export function toOpenAIToolChoice(
  directive: ToolDirective,
): ChatCompletionToolChoiceOption {
  switch (directive.kind) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return { type: "function", function: { name: directive.name } };
    default: {
      const exhaustive: never = directive;
      return exhaustive;
    }
  }
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
          arguments: JSON.stringify({
            query: call.query,
            excludePurchasedItems: call.excludePurchasedItems,
          }),
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

function parseOpenAIToolCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): ModelToolCall {
  if (call.type !== "function") {
    throw new ModelClientError("INTERNAL", "The model requested an unsupported tool type.");
  }

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
  } catch (error) {
    throw new ModelClientError("INTERNAL", "The model returned invalid tool arguments.", {
      cause: error,
    });
  }

  const parsed = parseModelToolCall({
    id: call.id,
    name: call.function.name,
    arguments: argumentsValue,
  });
  if (parsed === null) {
    throw new ModelClientError("INTERNAL", "The model returned invalid tool arguments.");
  }
  return parsed;
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
