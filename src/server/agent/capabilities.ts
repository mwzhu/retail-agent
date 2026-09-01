import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";

export const planningStrategySchema = z.enum(["auto", "sequence", "plan"]);
export type PlanningStrategy = z.infer<typeof planningStrategySchema>;

export const toolSpecVersionSchema = z.enum(["current", "guided"]);
export type ToolSpecVersion = z.infer<typeof toolSpecVersionSchema>;

export const toolNameSchema = z.enum([
  "lookup_order",
  "search_products",
  "claim_early_risers",
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export type ModelToolCall =
  | Readonly<{
      kind: "lookup_order";
      id: string;
      email: string;
      orderNumber: string;
    }>
  | Readonly<{ kind: "search_products"; id: string; query: string }>
  | Readonly<{ kind: "claim_early_risers"; id: string }>;

const lookupOrderParameters = {
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
} as const;

const searchProductsParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "A concise catalog search query based on the customer's request.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const claimPromotionParameters = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

const capabilityDefinitions = [
  {
    name: "lookup_order",
    descriptions: {
      current:
        "Look up one order after the customer has supplied both their email and order number.",
      guided:
        "Use for order status or tracking only when both an email address and complete order number are present, including when they appear in different conversation turns. Do not use when either value is missing.",
    },
    parameters: lookupOrderParameters,
  },
  {
    name: "search_products",
    descriptions: {
      current:
        "Search the Sierra Outfitters catalog for grounded recommendations or product facts.",
      guided:
        "Use for every request for product recommendations, what else to buy, catalog facts, inventory, price, gear, or equipment. Search before answering even when the customer supplies an alleged product fact. Do not answer a product request without this search.",
    },
    parameters: searchProductsParameters,
  },
  {
    name: "claim_early_risers",
    descriptions: {
      current:
        "Claim the Early Risers promotion. Use only when the customer explicitly asks to claim or receive it.",
      guided:
        "Use only when the customer's current message explicitly asks to claim, receive, redeem, get, or be given the Early Risers promotion. Do not use for questions about the promotion, negated requests, or unrelated discount requests.",
    },
    parameters: claimPromotionParameters,
  },
] as const;

export function createToolDefinitions(version: ToolSpecVersion): ChatCompletionTool[] {
  return capabilityDefinitions.map((capability) => ({
    type: "function",
    function: {
      name: capability.name,
      description: capability.descriptions[version],
      strict: true,
      parameters: capability.parameters,
    },
  }));
}

export function createIntentPlannerInstruction(version: ToolSpecVersion): string {
  const descriptions = capabilityDefinitions
    .map((capability) => `${capability.name}: ${capability.descriptions[version]}`)
    .join("\n");
  return `Plan the supported capabilities needed for the customer's current message. Return one value for every slot. Use state "none" when a capability is not needed. Do not infer a promotion claim from an information-only or negated request. Product search may be "after_order" only when its query depends on the order lookup result; otherwise use "independent".\n\n${descriptions}`;
}

const modelToolCallBoundarySchema = z.discriminatedUnion("name", [
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

export function parseModelToolCall(input: Readonly<{
  id: string;
  name: string;
  arguments: unknown;
}>): ModelToolCall | null {
  const parsed = modelToolCallBoundarySchema.safeParse({
    id: input.id,
    name: input.name,
    input: input.arguments,
  });
  if (!parsed.success) return null;

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

const intentPlanBoundarySchema = z
  .object({
    order: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }).strict(),
      z
        .object({
          state: z.literal("lookup"),
          email: z.string().min(1),
          orderNumber: z.string().min(1),
        })
        .strict(),
    ]),
    product: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }).strict(),
      z
        .object({
          state: z.literal("search"),
          query: z.string().min(1),
          timing: z.enum(["independent", "after_order"]),
        })
        .strict(),
    ]),
    promotion: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }).strict(),
      z.object({ state: z.literal("claim") }).strict(),
    ]),
  })
  .strict();

export type IntentPlan = z.infer<typeof intentPlanBoundarySchema>;
export type IntentPlanSlot = "order" | "product" | "promotion";

export type IntentPlanValidation =
  | Readonly<{ kind: "accepted"; plan: IntentPlan }>
  | Readonly<{ kind: "rejected"; reason: "invalid_shape" | "invalid_dependency" }>;

export function validateIntentPlan(input: unknown): IntentPlanValidation {
  const parsed = intentPlanBoundarySchema.safeParse(input);
  if (!parsed.success) return { kind: "rejected", reason: "invalid_shape" };
  if (
    parsed.data.product.state === "search"
    && parsed.data.product.timing === "after_order"
    && parsed.data.order.state === "none"
  ) {
    return { kind: "rejected", reason: "invalid_dependency" };
  }
  return { kind: "accepted", plan: parsed.data };
}

export function intentPlanJsonSchema() {
  return intentPlanBoundarySchema;
}
