import type { ChatMessage, Conversation, TurnErrorCode } from "../../shared/protocol";
import type {
  IntentPlanValidation,
  ModelToolCall,
  ToolName,
} from "./capabilities";

export type {
  IntentPlan,
  IntentPlanSlot,
  ModelToolCall,
  PlanningStrategy,
  ToolName,
  ToolSpecVersion,
} from "./capabilities";

export type TurnCommand =
  | Readonly<{ kind: "new"; conversationId: string; content: string }>
  | Readonly<{ kind: "retry"; conversationId: string }>;

export type TurnTerminal =
  | Readonly<{ kind: "completed"; assistant: ChatMessage }>
  | Readonly<{
      kind: "failed";
      code: TurnErrorCode;
      message: string;
      retryable: true;
    }>
  | Readonly<{ kind: "aborted" }>;

export type OpenTurnResult =
  | Readonly<{
      kind: "accepted";
      conversationId: string;
      source: ChatMessage;
      output: AsyncGenerator<Readonly<{ text: string }>, TurnTerminal, void>;
    }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "conversation_not_found"
        | "conversation_busy"
        | "pending_message_exists"
        | "no_pending_message";
    }>;

export interface ChatApplication {
  createConversation(): Conversation;
  getConversation(id: string): Conversation | null;
  openTurn(command: TurnCommand, signal: AbortSignal): Promise<OpenTurnResult>;
}

export type ModelMessage =
  | Readonly<{
      kind: "text";
      role: "system" | "user" | "assistant";
      content: string;
    }>
  | Readonly<{
      kind: "tool_calls";
      content: string | null;
      calls: readonly ModelToolCall[];
    }>
  | Readonly<{
      kind: "tool_result";
      callId: string;
      name: ModelToolCall["kind"];
      content: string;
    }>;

export type ToolDirective =
  | Readonly<{ kind: "auto" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "required"; name: ToolName }>;

export interface ModelToolSelectionRequest {
  readonly messages: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly directive: ToolDirective;
}

export interface ModelPlanningResult {
  readonly content: string | null;
  readonly calls: readonly ModelToolCall[];
}

export interface ModelIntentPlanningRequest {
  readonly messages: readonly ModelMessage[];
  readonly signal: AbortSignal;
}

export type ModelIntentPlanningResult =
  | IntentPlanValidation
  | Readonly<{ kind: "rejected"; reason: "provider_refusal" }>;

export interface ModelFinalRequest {
  readonly messages: readonly ModelMessage[];
  readonly signal: AbortSignal;
}

export interface ModelClient {
  selectTools(request: ModelToolSelectionRequest): Promise<ModelPlanningResult>;
  planIntents(request: ModelIntentPlanningRequest): Promise<ModelIntentPlanningResult>;
  streamFinal(request: ModelFinalRequest): AsyncIterable<string>;
}

export type ModelClientErrorCode = "MODEL_UNAVAILABLE" | "MODEL_TIMEOUT" | "INTERNAL";

export class ModelClientError extends Error {
  readonly code: ModelClientErrorCode;

  constructor(code: ModelClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelClientError";
    this.code = code;
  }
}
