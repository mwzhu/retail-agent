import type { ChatMessage, TurnErrorCode } from "../../shared/protocol";
import type { SierraStore } from "../contracts";
import {
  createCapabilityExecutorFactory,
  type CapabilityExecutionResult,
  type CapabilityExecutor,
  type CapabilityExecutorFactory,
} from "./executor";
import { FINAL_RESPONSE_INSTRUCTION, SIERRA_SYSTEM_PROMPT } from "./prompt";
import { selectToolDirective } from "./routing";
import {
  emitTrace,
  noOpTraceSink,
  type AgentTraceSink,
} from "./trace";
import {
  ModelClientError,
  type ChatApplication,
  type IntentPlan,
  type IntentPlanSlot,
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
  type OpenTurnResult,
  type PlanningStrategy,
  type ToolDirective,
  type ToolSpecVersion,
  type TurnCommand,
  type TurnTerminal,
} from "./types";

const MAX_HISTORY_MESSAGES = 20;
const MAX_PLANNING_ROUNDS = 3;

interface TurnContext {
  readonly conversationId: string;
  readonly source: ChatMessage;
  readonly history: readonly ChatMessage[];
}

type PlannedCall = Readonly<{ slot: IntentPlanSlot; call: ModelToolCall }>;
type ExecutedCall = Readonly<{
  slot: IntentPlanSlot;
  call: ModelToolCall;
  result: CapabilityExecutionResult;
}>;

export function createChatApplication(input: Readonly<{
  store: SierraStore;
  model: ModelClient;
  planningStrategy?: PlanningStrategy;
  toolSpecVersion?: ToolSpecVersion;
  now?: () => Date;
  monotonicNow?: () => number;
  trace?: AgentTraceSink;
  executorFactory?: CapabilityExecutorFactory;
}>): ChatApplication {
  const busyConversations = new Set<string>();
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const planningStrategy = input.planningStrategy ?? "sequence";
  const toolSpecVersion = input.toolSpecVersion ?? "current";
  const trace = input.trace ?? noOpTraceSink;
  const executorFactory = input.executorFactory
    ?? createCapabilityExecutorFactory({ store: input.store, now });

  return {
    createConversation: () => input.store.createConversation(),
    getConversation: (id) => input.store.getConversation(id),
    openTurn: async (command, signal) => {
      if (busyConversations.has(command.conversationId)) {
        return { kind: "rejected", reason: "conversation_busy" };
      }

      busyConversations.add(command.conversationId);
      try {
        const prepared = prepareTurn(input.store, command);
        if (prepared.kind === "rejected") {
          busyConversations.delete(command.conversationId);
          return { kind: "rejected", reason: prepared.rejection.kind };
        }

        const context: TurnContext = {
          conversationId: command.conversationId,
          source: prepared.turn.source,
          history: prepared.turn.history,
        };
        const output = runTurn({
          context,
          store: input.store,
          model: input.model,
          planningStrategy,
          toolSpecVersion,
          signal,
          trace,
          monotonicNow,
          executor: executorFactory({
            conversationId: context.conversationId,
            sourceContent: context.source.content,
            priorContents: context.history
              .filter((message) => message.id !== context.source.id)
              .map((message) => message.content),
          }),
          release: () => busyConversations.delete(command.conversationId),
        });
        return {
          kind: "accepted",
          conversationId: command.conversationId,
          source: prepared.turn.source,
          output,
        };
      } catch (error) {
        busyConversations.delete(command.conversationId);
        throw error;
      }
    },
  };
}

function prepareTurn(store: SierraStore, command: TurnCommand) {
  switch (command.kind) {
    case "new":
      return store.prepareNewTurn({
        conversationId: command.conversationId,
        content: command.content,
      });
    case "retry":
      return store.prepareRetry(command.conversationId);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

async function* runTurn(input: Readonly<{
  context: TurnContext;
  store: SierraStore;
  model: ModelClient;
  planningStrategy: PlanningStrategy;
  toolSpecVersion: ToolSpecVersion;
  signal: AbortSignal;
  trace: AgentTraceSink;
  monotonicNow: () => number;
  executor: CapabilityExecutor;
  release: () => void;
}>): AsyncGenerator<Readonly<{ text: string }>, TurnTerminal, void> {
  const sourceMessageId = input.context.source.id;
  let modelCallIndex = 0;
  try {
    if (input.signal.aborted) return { kind: "aborted" };

    emitTrace(input.trace, {
      kind: "turn.started",
      sourceMessageId,
      strategy: input.planningStrategy,
      toolSpecVersion: input.toolSpecVersion,
      atMs: input.monotonicNow(),
    });
    const messages = buildInitialMessages(input.context);

    if (input.planningStrategy === "plan") {
      modelCallIndex += 1;
      await runStructuredPlan({
        messages,
        model: input.model,
        signal: input.signal,
        sourceMessageId,
        modelCallIndex,
        executor: input.executor,
        trace: input.trace,
        monotonicNow: input.monotonicNow,
      });
    } else {
      modelCallIndex = await runIterativePlanning({
        messages,
        model: input.model,
        strategy: input.planningStrategy,
        signal: input.signal,
        sourceMessageId,
        executor: input.executor,
        trace: input.trace,
        monotonicNow: input.monotonicNow,
      });
    }

    if (input.signal.aborted) return { kind: "aborted" };
    messages.push({ kind: "text", role: "system", content: FINAL_RESPONSE_INSTRUCTION });

    modelCallIndex += 1;
    const finalCallIndex = modelCallIndex;
    const finalStartedAt = input.monotonicNow();
    emitTrace(input.trace, {
      kind: "final.started",
      sourceMessageId,
      modelCallIndex: finalCallIndex,
      atMs: finalStartedAt,
    });

    let finalText = "";
    let emittedFirstToken = false;
    for await (const text of input.model.streamFinal({ messages, signal: input.signal })) {
      if (input.signal.aborted) return { kind: "aborted" };
      if (text.length === 0) continue;
      if (!emittedFirstToken) {
        emittedFirstToken = true;
        emitTrace(input.trace, {
          kind: "final.first_token",
          sourceMessageId,
          modelCallIndex: finalCallIndex,
          ttftMs: input.monotonicNow() - finalStartedAt,
        });
      }
      finalText += text;
      yield { text };
    }
    emitTrace(input.trace, {
      kind: "final.completed",
      sourceMessageId,
      modelCallIndex: finalCallIndex,
      durationMs: input.monotonicNow() - finalStartedAt,
    });

    if (input.signal.aborted) return { kind: "aborted" };
    if (finalText.trim().length === 0) {
      return failedTerminal(
        "EMPTY_FINAL_RESPONSE",
        "The assistant returned an empty response. Please retry.",
      );
    }

    const assistant = input.store.completeTurn({ sourceMessageId, content: finalText });
    return { kind: "completed", assistant };
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) return { kind: "aborted" };
    if (error instanceof ModelClientError) {
      return failedTerminal(error.code, safeModelErrorMessage(error.code));
    }
    return failedTerminal("INTERNAL", "The turn could not be completed. Please retry.");
  } finally {
    input.release();
  }
}

async function runIterativePlanning(input: Readonly<{
  messages: ModelMessage[];
  model: ModelClient;
  strategy: Exclude<PlanningStrategy, "plan">;
  signal: AbortSignal;
  sourceMessageId: string;
  executor: CapabilityExecutor;
  trace: AgentTraceSink;
  monotonicNow: () => number;
}>): Promise<number> {
  let modelCallIndex = 0;
  for (let round = 0; round < MAX_PLANNING_ROUNDS; round += 1) {
    modelCallIndex += 1;
    const directive: ToolDirective = input.strategy === "auto"
      ? { kind: "auto" }
      : selectToolDirective(input.messages);
    const startedAt = input.monotonicNow();
    const plan = await input.model.selectTools({
      messages: input.messages,
      signal: input.signal,
      directive,
    });
    emitTrace(input.trace, {
      kind: "planning.completed",
      sourceMessageId: input.sourceMessageId,
      modelCallIndex,
      durationMs: input.monotonicNow() - startedAt,
      proposedCalls: plan.calls.map((call) => call.kind),
      proposedPlan: null,
      validationRejection: null,
    });
    if (input.signal.aborted || plan.calls.length === 0) break;

    input.messages.push({ kind: "tool_calls", content: plan.content, calls: plan.calls });
    const executed = await executeSerial({
      calls: plan.calls.map((call) => ({ slot: slotForTool(call.kind), call })),
      batch: round,
      sourceMessageId: input.sourceMessageId,
      executor: input.executor,
      trace: input.trace,
      monotonicNow: input.monotonicNow,
    });
    appendResults(input.messages, executed);
  }
  return modelCallIndex;
}

async function runStructuredPlan(input: Readonly<{
  messages: ModelMessage[];
  model: ModelClient;
  signal: AbortSignal;
  sourceMessageId: string;
  modelCallIndex: number;
  executor: CapabilityExecutor;
  trace: AgentTraceSink;
  monotonicNow: () => number;
}>): Promise<void> {
  const startedAt = input.monotonicNow();
  const result = await input.model.planIntents({
    messages: input.messages,
    signal: input.signal,
  });
  const plan = result.kind === "accepted" ? result.plan : null;
  const batches = plan === null ? [] : planToBatches(plan, input.sourceMessageId);
  const calls = batches.flat();
  emitTrace(input.trace, {
    kind: "planning.completed",
    sourceMessageId: input.sourceMessageId,
    modelCallIndex: input.modelCallIndex,
    durationMs: input.monotonicNow() - startedAt,
    proposedCalls: calls.map(({ call }) => call.kind),
    proposedPlan: plan === null ? null : summarizePlan(plan),
    validationRejection: result.kind === "rejected" ? result.reason : null,
  });
  if (calls.length === 0 || input.signal.aborted) return;

  input.messages.push({
    kind: "tool_calls",
    content: null,
    calls: calls.map(({ call }) => call),
  });
  const executed: ExecutedCall[] = [];
  for (let batch = 0; batch < batches.length; batch += 1) {
    const batchCalls = batches.at(batch);
    if (batchCalls === undefined) continue;
    executed.push(...await executeConcurrent({
      calls: batchCalls,
      batch,
      sourceMessageId: input.sourceMessageId,
      executor: input.executor,
      trace: input.trace,
      monotonicNow: input.monotonicNow,
    }));
  }
  appendResults(input.messages, executed);
}

function planToBatches(plan: IntentPlan, sourceMessageId: string): PlannedCall[][] {
  const order = plan.order.state === "lookup"
    ? {
        slot: "order" as const,
        call: {
          kind: "lookup_order" as const,
          id: `${sourceMessageId}:order`,
          email: plan.order.email,
          orderNumber: plan.order.orderNumber,
        },
      }
    : null;
  const product = plan.product.state === "search"
    ? {
        slot: "product" as const,
        call: {
          kind: "search_products" as const,
          id: `${sourceMessageId}:product`,
          query: plan.product.query,
          excludePurchasedItems: plan.product.excludePurchasedItems,
        },
      }
    : null;
  const promotion = plan.promotion.state === "claim"
    ? {
        slot: "promotion" as const,
        call: {
          kind: "claim_early_risers" as const,
          id: `${sourceMessageId}:promotion`,
        },
      }
    : null;
  const firstBatch = [order, product, promotion].flatMap((planned) => {
    if (planned === null) return [];
    if (
      planned.slot === "product"
      && plan.product.state === "search"
      && plan.product.timing === "after_order"
    ) return [];
    return [planned];
  });
  if (
    product !== null
    && plan.product.state === "search"
    && plan.product.timing === "after_order"
  ) {
    return [firstBatch, [product]];
  }
  return firstBatch.length === 0 ? [] : [firstBatch];
}

async function executeSerial(input: Readonly<{
  calls: readonly PlannedCall[];
  batch: number;
  sourceMessageId: string;
  executor: CapabilityExecutor;
  trace: AgentTraceSink;
  monotonicNow: () => number;
}>): Promise<ExecutedCall[]> {
  const results: ExecutedCall[] = [];
  for (const [slotIndex, planned] of input.calls.entries()) {
    results.push(await executeOne({ ...input, planned, slotIndex }));
  }
  return results;
}

async function executeConcurrent(input: Readonly<{
  calls: readonly PlannedCall[];
  batch: number;
  sourceMessageId: string;
  executor: CapabilityExecutor;
  trace: AgentTraceSink;
  monotonicNow: () => number;
}>): Promise<ExecutedCall[]> {
  return Promise.all(input.calls.map((planned, slotIndex) =>
    executeOne({ ...input, planned, slotIndex })));
}

async function executeOne(input: Readonly<{
  planned: PlannedCall;
  batch: number;
  slotIndex: number;
  sourceMessageId: string;
  executor: CapabilityExecutor;
  trace: AgentTraceSink;
  monotonicNow: () => number;
}>): Promise<ExecutedCall> {
  const startedAt = input.monotonicNow();
  emitTrace(input.trace, {
    kind: "execution.started",
    sourceMessageId: input.sourceMessageId,
    batch: input.batch,
    slotIndex: input.slotIndex,
    slot: input.planned.slot,
    call: input.planned.call,
    atMs: startedAt,
  });
  const result = await input.executor.execute(input.planned.call);
  if (result.outcome.tool !== input.planned.call.kind) {
    throw new Error("Capability executor returned an outcome for a different tool.");
  }
  emitTrace(input.trace, {
    kind: "execution.completed",
    sourceMessageId: input.sourceMessageId,
    batch: input.batch,
    slotIndex: input.slotIndex,
    slot: input.planned.slot,
    call: input.planned.call,
    durationMs: input.monotonicNow() - startedAt,
    outcome: result.outcome,
  });
  return { ...input.planned, result };
}

function appendResults(messages: ModelMessage[], executed: readonly ExecutedCall[]): void {
  for (const item of executed) {
    messages.push({
      kind: "tool_result",
      callId: item.call.id,
      name: item.call.kind,
      content: item.result.content,
    });
  }
}

function slotForTool(tool: ModelToolCall["kind"]): IntentPlanSlot {
  switch (tool) {
    case "lookup_order":
      return "order";
    case "search_products":
      return "product";
    case "claim_early_risers":
      return "promotion";
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

function summarizePlan(plan: IntentPlan) {
  return {
    order: plan.order.state,
    product: plan.product.state === "none" ? "none" : plan.product.timing,
    promotion: plan.promotion.state,
  } as const;
}

function buildInitialMessages(context: TurnContext): ModelMessage[] {
  const historyWithoutSource = context.history.filter(
    (message) => message.id !== context.source.id,
  );
  const recentHistory = [...historyWithoutSource, context.source].slice(-MAX_HISTORY_MESSAGES);
  return [
    { kind: "text", role: "system", content: SIERRA_SYSTEM_PROMPT },
    ...recentHistory.map(toModelTextMessage),
  ];
}

function toModelTextMessage(message: ChatMessage): ModelMessage {
  return { kind: "text", role: message.role, content: message.content };
}

function failedTerminal(code: TurnErrorCode, message: string): TurnTerminal {
  return { kind: "failed", code, message, retryable: true };
}

function safeModelErrorMessage(code: ModelClientError["code"]): string {
  switch (code) {
    case "MODEL_UNAVAILABLE":
      return "The assistant is unavailable right now. Please retry.";
    case "MODEL_TIMEOUT":
      return "The assistant took too long to respond. Please retry.";
    case "INTERNAL":
      return "The assistant could not complete the turn. Please retry.";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
