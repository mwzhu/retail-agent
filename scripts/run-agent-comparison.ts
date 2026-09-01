import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { architectureStudyCorpus } from "./architecture-study/corpus";
import { renderStudyReport } from "./architecture-study/report";
import {
  planningStrategies,
  toolSpecVersions,
  type GoldScenario,
  type ObservedToolCall,
  type ObservedTurnTrace,
  type PlanningStrategy,
  type StudyCellObservation,
  type ToolSpecVersion,
} from "./architecture-study/types";
import {
  createToolDefinitions,
  type AgentTraceEvent,
  type AgentTraceSink,
  type ModelToolCall,
} from "../src/server/agent";
import { FINAL_RESPONSE_INSTRUCTION, SIERRA_SYSTEM_PROMPT } from "../src/server/agent/prompt";
import { loadConfig, type AppConfig } from "../src/server/config";
import { buildServer, type ServerClock } from "../src/server/index";
import {
  chatStreamEventSchema,
  type ChatStreamEvent,
} from "../src/shared/protocol";

const FIXED_NOW = "2026-08-31T20:00:00.000Z";
const LABELS = ["cedar", "granite", "lichen", "river", "talus", "willow"] as const;

interface Cell {
  readonly strategy: PlanningStrategy;
  readonly toolSpec: ToolSpecVersion;
}

interface TurnResponse {
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly response: string;
  readonly totalMs: number;
  readonly timeToFirstTokenMs: number;
}

interface CellRun {
  readonly cell: Cell;
  readonly repetition: number;
  readonly observations: readonly ObservedTurnTrace[];
  readonly trace: readonly AgentTraceEvent[];
}

const runId = readArgument("run-id")
  ?? `matrix-${new Date().toISOString().replaceAll(":", "-")}`;
const repetitions = readPositiveInteger("repetitions", 1);
const outputDirectory = resolve(readArgument("output") ?? `.audit/agent-comparison/${runId}`);
const selectedIds = new Set(
  (readArgument("ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
);

function readArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function readPositiveInteger(name: string, defaultValue: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function cellKey(cell: Cell): string {
  return `${cell.strategy}/${cell.toolSpec}`;
}

function allCells(): readonly Cell[] {
  return planningStrategies.flatMap((strategy) =>
    toolSpecVersions.map((toolSpec) => ({ strategy, toolSpec })));
}

function selectCorpus(): readonly GoldScenario[] {
  const corpus = architectureStudyCorpus();
  if (selectedIds.size === 0) return corpus;
  const selected = corpus.filter((scenario) => selectedIds.has(scenario.id));
  const found = new Set(selected.map((scenario) => scenario.id));
  const missing = [...selectedIds].filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Unknown scenario IDs: ${missing.join(", ")}.`);
  return selected;
}

function seededCellOrder(cells: readonly Cell[], seed: string): readonly Cell[] {
  let state = [...seed].reduce(
    (value, character) => Math.imul(value ^ character.charCodeAt(0), 16_777_619),
    2_166_136_261,
  ) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const shuffled = [...cells];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    const currentValue = shuffled[index];
    const otherValue = shuffled[other];
    if (currentValue === undefined || otherValue === undefined) continue;
    shuffled[index] = otherValue;
    shuffled[other] = currentValue;
  }
  return shuffled;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function createClock(): ServerClock {
  return {
    now: () => new Date(FIXED_NOW),
    monotonicNow: () => performance.now(),
  };
}

async function readTurnResponse(
  baseUrl: string,
  prompt: string,
  conversationId: string | undefined,
): Promise<TurnResponse> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: prompt,
      ...(conversationId === undefined ? {} : { conversationId }),
    }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Chat request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw new Error("Chat response was not NDJSON.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ChatStreamEvent[] = [];
  let buffer = "";
  let firstTokenAt: number | null = null;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      const event = chatStreamEventSchema.parse(JSON.parse(line));
      if (event.type === "assistant.delta" && firstTokenAt === null) {
        firstTokenAt = performance.now();
      }
      events.push(event);
    }
    if (chunk.done) break;
  }
  if (buffer.trim().length > 0) {
    events.push(chatStreamEventSchema.parse(JSON.parse(buffer)));
  }

  const accepted = events.at(0);
  const terminal = events.at(-1);
  if (accepted?.type !== "turn.accepted") {
    throw new Error("Chat stream did not begin with turn.accepted.");
  }
  if (terminal?.type !== "turn.completed") {
    throw new Error(`Chat stream ended with ${terminal?.type ?? "no terminal event"}.`);
  }
  const text = events
    .filter((event): event is Extract<ChatStreamEvent, { type: "assistant.delta" }> =>
      event.type === "assistant.delta")
    .map((event) => event.text)
    .join("");
  if (text !== terminal.assistantMessage.content) {
    throw new Error("Streamed deltas did not equal the completed assistant response.");
  }
  const completedAt = performance.now();
  return {
    conversationId: accepted.conversationId,
    sourceMessageId: accepted.userMessage.id,
    response: text,
    totalMs: completedAt - startedAt,
    timeToFirstTokenMs: (firstTokenAt ?? completedAt) - startedAt,
  };
}

function toolExecutionDuration(events: readonly AgentTraceEvent[]): number {
  const starts = new Map<string, number>();
  const ranges = new Map<number, { start: number; end: number }>();
  for (const event of events) {
    if (event.kind === "execution.started") {
      starts.set(event.call.id, event.atMs);
    }
    if (event.kind === "execution.completed") {
      const start = starts.get(event.call.id);
      if (start === undefined) continue;
      const end = start + event.durationMs;
      const range = ranges.get(event.batch);
      ranges.set(event.batch, range === undefined
        ? { start, end }
        : { start: Math.min(range.start, start), end: Math.max(range.end, end) });
    }
  }
  return [...ranges.values()].reduce((total, range) => total + range.end - range.start, 0);
}

function observedCall(call: ModelToolCall, sequence: number, wave: number): ObservedToolCall {
  switch (call.kind) {
    case "lookup_order":
      return {
        tool: call.kind,
        arguments: { email: call.email, orderNumber: call.orderNumber },
        callId: call.id,
        sequence,
        wave,
      };
    case "search_products":
      return {
        tool: call.kind,
        arguments: { query: call.query },
        callId: call.id,
        sequence,
        wave,
      };
    case "claim_early_risers":
      return {
        tool: call.kind,
        arguments: {},
        callId: call.id,
        sequence,
        wave,
      };
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

function toObservation(input: Readonly<{
  scenarioId: string;
  turnIndex: number;
  repetition: number;
  response: TurnResponse;
  events: readonly AgentTraceEvent[];
}>): ObservedTurnTrace {
  const executions = input.events
    .filter((event) => event.kind === "execution.completed")
    .sort((left, right) => left.batch - right.batch || left.slotIndex - right.slotIndex);
  const planningMs = input.events
    .filter((event) => event.kind === "planning.completed")
    .reduce((total, event) => total + event.durationMs, 0);
  const finalMs = input.events.find((event) => event.kind === "final.completed")?.durationMs ?? 0;
  return {
    scenarioId: input.scenarioId,
    turnIndex: input.turnIndex,
    repetition: input.repetition,
    calls: executions.map((event, sequence) =>
      observedCall(event.call, sequence, event.batch)),
    response: input.response.response,
    modelCallCount: input.events.filter((event) =>
      event.kind === "planning.completed" || event.kind === "final.completed").length,
    latency: {
      totalMs: input.response.totalMs,
      timeToFirstTokenMs: input.response.timeToFirstTokenMs,
      planningMs,
      toolExecutionMs: toolExecutionDuration(input.events),
      finalResponseMs: finalMs,
    },
  };
}

async function runCell(input: Readonly<{
  baseConfig: AppConfig;
  cell: Cell;
  repetition: number;
  corpus: readonly GoldScenario[];
  workspace: string;
}>): Promise<CellRun> {
  const traceEvents: AgentTraceEvent[] = [];
  const trace: AgentTraceSink = { emit: (event) => traceEvents.push(event) };
  const databasePath = resolve(input.workspace, "sierra.db");
  const config: AppConfig = {
    ...input.baseConfig,
    port: 0,
    databasePath,
    demoMode: false,
    planningStrategy: input.cell.strategy,
    toolSpecVersion: input.cell.toolSpec,
    tracePath: undefined,
  };
  const { app } = await buildServer({
    config,
    clock: createClock(),
    trace,
    logger: false,
  });
  let baseUrl: string | null = null;
  try {
    baseUrl = await app.listen({ port: 0, host: config.host });
    const health = await fetch(`${baseUrl}/api/health`);
    if (!health.ok || (await health.json() as { mode?: string }).mode !== "openai") {
      throw new Error(`Cell ${cellKey(input.cell)} did not start in OpenAI mode.`);
    }
    const observations: ObservedTurnTrace[] = [];
    for (const [scenarioIndex, scenario] of input.corpus.entries()) {
      process.stdout.write(
        `  ${cellKey(input.cell)} rep ${input.repetition + 1}: ${scenario.id} `
        + `(${scenarioIndex + 1}/${input.corpus.length})\n`,
      );
      let conversationId: string | undefined;
      for (const [turnIndex, turn] of scenario.turns.entries()) {
        const response = await readTurnResponse(baseUrl, turn.prompt, conversationId);
        conversationId = response.conversationId;
        const events = traceEvents.filter((event) =>
          event.sourceMessageId === response.sourceMessageId);
        observations.push(toObservation({
          scenarioId: scenario.id,
          turnIndex,
          repetition: input.repetition,
          response,
          events,
        }));
      }
    }
    return { cell: input.cell, repetition: input.repetition, observations, trace: traceEvents };
  } finally {
    await app.close();
  }
}

function labelMapping(cells: readonly Cell[]): Readonly<Record<string, string>> {
  return Object.fromEntries(cells.map((cell, index) => [cellKey(cell), LABELS[index]]));
}

function judgeInput(
  corpus: readonly GoldScenario[],
  observations: readonly StudyCellObservation[],
  labels: Readonly<Record<string, string>>,
) {
  return corpus.flatMap((scenario) => scenario.turns.map((turn, turnIndex) => ({
    scenarioId: scenario.id,
    turnIndex,
    prompt: turn.prompt,
    candidates: Object.fromEntries(observations.map((cell) => {
      const response = cell.traces.find((trace) =>
        trace.repetition === 0
        && trace.scenarioId === scenario.id
        && trace.turnIndex === turnIndex)?.response;
      return [labels[`${cell.strategy}/${cell.toolSpec}`], response];
    })),
  })));
}

function secretScan(value: string): void {
  if (/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]+/.test(value)) {
    throw new Error("A secret-shaped value appeared in the comparison artifact.");
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Output directory already exists: ${path}`);
}

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  if (baseConfig.apiKey === undefined) {
    throw new Error("OPENAI_API_KEY is required for the architecture comparison.");
  }
  const corpus = selectCorpus();
  const cells = allCells();
  const tempDirectory = `${outputDirectory}.tmp-${process.pid}`;
  await mkdir(dirname(outputDirectory), { recursive: true });
  await rm(tempDirectory, { recursive: true, force: true });
  await assertPathAbsent(outputDirectory);
  await mkdir(tempDirectory, { recursive: true });

  const cellOrders = Array.from({ length: repetitions }, (_, repetition) =>
    seededCellOrder(cells, `${runId}:${repetition}`));
  const runs: CellRun[] = [];
  for (const [repetition, order] of cellOrders.entries()) {
    for (const cell of order) {
      const workspace = resolve(
        tempDirectory,
        `${cell.strategy}-${cell.toolSpec}`,
        `rep-${repetition + 1}`,
      );
      await mkdir(workspace, { recursive: true });
      runs.push(await runCell({
        baseConfig,
        cell,
        repetition,
        corpus,
        workspace,
      }));
    }
  }

  const observations: StudyCellObservation[] = cells.map((cell) => ({
    ...cell,
    traces: runs
      .filter((run) => cellKey(run.cell) === cellKey(cell))
      .flatMap((run) => run.observations),
  }));
  const report = renderStudyReport(corpus, observations);
  const labels = labelMapping(seededCellOrder(cells, `${runId}:labels`));
  const manifest = {
    runId,
    generatedAt: new Date().toISOString(),
    repetitions,
    fixedNow: FIXED_NOW,
    model: baseConfig.model,
    temperature: 0,
    gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    fixtureHashes: {
      orders: await fileHash(baseConfig.ordersPath),
      products: await fileHash(baseConfig.productsPath),
    },
    promptHashes: {
      system: sha256(SIERRA_SYSTEM_PROMPT),
      final: sha256(FINAL_RESPONSE_INSTRUCTION),
      corpus: sha256(JSON.stringify(corpus.map((scenario) => ({
        id: scenario.id,
        prompts: scenario.turns.map((turn) => turn.prompt),
      })))),
    },
    toolSpecHashes: Object.fromEntries(toolSpecVersions.map((version) => [
      version,
      sha256(JSON.stringify(createToolDefinitions(version))),
    ])),
    scenarioIds: corpus.map((scenario) => scenario.id),
    cellOrders: cellOrders.map((order) => order.map(cellKey)),
  };
  const results = JSON.stringify({
    manifest,
    matrix: report.matrix,
    deltas: report.deltas,
    observations,
  }, null, 2);
  const mapping = JSON.stringify({ labels }, null, 2);
  const blinded = JSON.stringify({ prompts: judgeInput(corpus, observations, labels) }, null, 2);
  const markdown = `${[
    "# Controlled agent architecture comparison",
    "",
    `Run: ${runId}`,
    `Model: ${baseConfig.model}`,
    `Repetitions: ${repetitions}`,
    `Scenarios: ${corpus.length}`,
    `Turns per cell per repetition: ${corpus.reduce((total, scenario) => total + scenario.turns.length, 0)}`,
    `Fixed clock: ${FIXED_NOW}`,
    "",
    "Only planning strategy and capability-description version vary. The original auto cell keeps provider parallel tool calls disabled; only the structured planner executes independent capabilities concurrently.",
    "",
    report.markdown,
  ].join("\n")}\n`;
  for (const value of [results, mapping, blinded, markdown]) secretScan(value);

  await Promise.all([
    writeFile(resolve(tempDirectory, "results.json"), `${results}\n`, "utf8"),
    writeFile(resolve(tempDirectory, "report.md"), markdown, "utf8"),
    writeFile(resolve(tempDirectory, "blind-labels.json"), `${mapping}\n`, "utf8"),
    writeFile(resolve(tempDirectory, "judge-input.json"), `${blinded}\n`, "utf8"),
    ...runs.map((run) => writeFile(
      resolve(
        tempDirectory,
        `${run.cell.strategy}-${run.cell.toolSpec}`,
        `rep-${run.repetition + 1}`,
        "trace.ndjson",
      ),
      `${run.trace.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    )),
  ]);
  await rename(tempDirectory, outputDirectory);
  process.stdout.write(`Comparison written to ${outputDirectory}\n`);
}

await main();
