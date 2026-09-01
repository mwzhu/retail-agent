import { z } from "zod";

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  createdAt: z.string().min(1),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationSchema = z.object({
  id: z.string().min(1),
  messages: z.array(chatMessageSchema),
  pendingUserMessageId: z.string().nullable(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["openai", "unconfigured"]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type HealthMode = HealthResponse["mode"];

export const chatRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(4_000),
});

export const retryRequestSchema = z.object({
  conversationId: z.string().min(1),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type RetryRequest = z.infer<typeof retryRequestSchema>;

export const turnErrorCodeSchema = z.enum([
  "MODEL_UNAVAILABLE",
  "MODEL_TIMEOUT",
  "EMPTY_FINAL_RESPONSE",
  "INTERNAL",
  "CONNECTION_LOST",
]);

export type TurnErrorCode = z.infer<typeof turnErrorCodeSchema>;

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn.accepted"),
    conversationId: z.string(),
    userMessage: chatMessageSchema,
  }),
  z.object({ type: z.literal("assistant.delta"), text: z.string() }),
  z.object({ type: z.literal("turn.completed"), assistantMessage: chatMessageSchema }),
  z.object({
    type: z.literal("turn.failed"),
    code: turnErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
