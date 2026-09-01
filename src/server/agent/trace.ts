import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  IntentPlanSlot,
  PlanningStrategy,
  ToolName,
  ToolSpecVersion,
} from "./capabilities";

type PlanningSummary = Readonly<{
  order: "none" | "lookup";
  product: "none" | "independent" | "after_order";
  promotion: "none" | "claim";
}>;

export type AgentTraceEvent =
  | Readonly<{
      kind: "turn.started";
      sourceMessageId: string;
      strategy: PlanningStrategy;
      toolSpecVersion: ToolSpecVersion;
      atMs: number;
    }>
  | Readonly<{
      kind: "planning.completed";
      sourceMessageId: string;
      modelCallIndex: number;
      durationMs: number;
      proposedCalls: readonly ToolName[];
      proposedPlan: PlanningSummary | null;
      validationRejection: "invalid_shape" | "invalid_dependency" | "provider_refusal" | null;
    }>
  | Readonly<{
      kind: "execution.started";
      sourceMessageId: string;
      batch: number;
      slot: IntentPlanSlot;
      tool: ToolName;
      atMs: number;
    }>
  | Readonly<{
      kind: "execution.completed";
      sourceMessageId: string;
      batch: number;
      slot: IntentPlanSlot;
      tool: ToolName;
      durationMs: number;
      resultKind: string;
    }>
  | Readonly<{
      kind: "final.started";
      sourceMessageId: string;
      modelCallIndex: number;
      atMs: number;
    }>
  | Readonly<{
      kind: "final.first_token";
      sourceMessageId: string;
      modelCallIndex: number;
      ttftMs: number;
    }>
  | Readonly<{
      kind: "final.completed";
      sourceMessageId: string;
      modelCallIndex: number;
      durationMs: number;
    }>;

export interface AgentTraceSink {
  emit(event: AgentTraceEvent): void;
}

export const noOpTraceSink: AgentTraceSink = { emit: () => undefined };

export function createNdjsonTraceSink(path: string): AgentTraceSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    emit: (event) => appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8"),
  };
}

export function emitTrace(sink: AgentTraceSink, event: AgentTraceEvent): void {
  try {
    sink.emit(event);
  } catch {
    // Observability must never change customer-facing behavior.
  }
}
