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
  | Readonly<{
      kind: "search_products";
      id: string;
      query: string;
      excludePurchasedItems: boolean;
    }>
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
    excludePurchasedItems: {
      type: "boolean",
      description:
        "True only for what-else or something-different recommendations based on a verified order. False for replacements and product requests merely paired with order tracking.",
    },
  },
  required: ["query", "excludePurchasedItems"],
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
        "Look up one order's status, tracking, and purchased items after the customer has supplied both their email and order number.",
      guided:
        "Use for order status, tracking, or purchased-item contents only when both an email address and complete order number are present, including when they appear in different conversation turns. Do not use when either value is missing.",
    },
    parameters: lookupOrderParameters,
  },
  {
    name: "search_products",
    descriptions: {
      current:
        "Search the Sierra Outfitters catalog for grounded recommendations or product facts, including food, drink, snack, appetite, whole-catalog, and raw-catalog requests. Set excludePurchasedItems only for what-else or something-different recommendations based on a verified order, not replacements or unrelated product requests paired with tracking.",
      guided:
        "Use for every request for product recommendations, what else to buy, catalog facts, food, drinks, snacks, hunger, inventory, price, gear, equipment, the full catalog, or raw catalog data. Search before answering even when the final response must refuse a bulk dump. Set excludePurchasedItems to true only for what-else or something-different recommendations based on a verified order. Keep it false for replacements and for an independent product request that merely appears beside order tracking. Do not answer a product request without this search.",
    },
    parameters: searchProductsParameters,
  },
  {
    name: "claim_early_risers",
    descriptions: {
      current:
        "Claim the Early Risers (also called Early Riser) promotion. Use only when the customer explicitly asks to claim, receive, or get its code.",
      guided:
        "Use only when the customer's current message explicitly asks to claim, receive, redeem, get, be given, or get a code for the Early Risers/Early Riser promotion. Do not use for questions about the promotion, negated requests, or unrelated discount requests.",
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
  return `Plan the supported capabilities needed for the customer's current message. Return one value for every slot. Use state "none" when a capability is not needed. Treat "Early Riser" as an alias for "Early Risers." A current explicit request such as "give me this promotion" or "give me the Early Riser code" may claim Early Risers only when the named or contextual promotion is established. Do not infer a promotion claim from an information-only or negated request. Schedule product search even for a request for the full catalog or raw catalog data; the final response can still refuse an unsafe bulk dump. Do not repeat an order lookup when verified order context is provided; its status, tracking, items, and recommendation profile remain available. Set product timing to "after_order" only when the current lookup result must drive the product search; use "independent" for a product request merely paired with order tracking. Set excludePurchasedItems to true only for what-else or something-different recommendations based on a verified order. The server will derive the retrieval query from that order's verified product metadata. Set it to false for replacements and unrelated product requests. Examples: tracking plus beginner skis is independent with exclusions false; a replacement backpack is exclusions false; something different based on the current order is after_order with exclusions true; what else based on an earlier verified order is independent with exclusions true.\n\n${descriptions}`;
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
    input: z
      .object({
        query: z.string().min(1),
        excludePurchasedItems: z.boolean(),
      })
      .strict(),
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
        excludePurchasedItems: parsed.data.input.excludePurchasedItems,
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
          excludePurchasedItems: z.boolean(),
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
  if (
    parsed.data.order.state === "lookup"
    && parsed.data.product.state === "search"
    && parsed.data.product.excludePurchasedItems
    && parsed.data.product.timing === "independent"
  ) {
    return { kind: "rejected", reason: "invalid_dependency" };
  }
  return { kind: "accepted", plan: parsed.data };
}

export function intentPlanJsonSchema() {
  return intentPlanBoundarySchema;
}
