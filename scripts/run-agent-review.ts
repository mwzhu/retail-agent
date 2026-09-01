import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { APPROVED_TRAIL_FLOURISHES, TRAIL_SIGNOFF } from "../src/server/agent/prompt";
import { conversationSchema, chatStreamEventSchema, type ChatStreamEvent } from "../src/shared/protocol";
import { reviewScenarios, type ReviewScenario, type Severity } from "./agent-review/scenarios";

interface ProbeResult {
  readonly title: string;
  readonly severity: Severity;
  readonly passed: boolean;
  readonly detail: string | null;
}

interface ObservedTurn {
  readonly prompt: string;
  readonly response: string;
  readonly conversationId: string;
  readonly events: readonly ChatStreamEvent[];
  readonly protocolChecks: readonly ProbeResult[];
  readonly semanticChecks: readonly ProbeResult[];
  readonly judgments: readonly { title: string; severity: Severity; status: "review_required" }[];
  readonly durationMs: number;
}

interface ScenarioResult {
  readonly id: string;
  readonly category: ReviewScenario["category"];
  readonly title: string;
  readonly status: "blocked" | "review_required";
  readonly turns: readonly ObservedTurn[];
}

const BRAND_VOICE_JUDGMENT = {
  title: "The outdoor flourish is brief and fits the response, with calm, respectful wording for bad news",
  severity: "release_blocking",
  status: "review_required",
} satisfies ObservedTurn["judgments"][number];

const baseUrl = process.env.SIERRA_REVIEW_BASE_URL ?? "http://127.0.0.1:3001";
const outputArg = process.argv.find((argument) => argument.startsWith("--output="));
const idsArg = process.argv.find((argument) => argument.startsWith("--ids="));
const outputDirectory = resolve(outputArg?.slice("--output=".length)
  ?? `.audit/agent-review/${new Date().toISOString().replaceAll(":", "-")}`);

function result(title: string, passed: boolean, detail: string | null = null): ProbeResult {
  return { title, severity: "release_blocking", passed, detail: passed ? null : detail };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseEvents(body: string): readonly ChatStreamEvent[] {
  const lines = body.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => chatStreamEventSchema.parse(JSON.parse(line)));
}

function globalResponseChecks(response: string): readonly ProbeResult[] {
  const mountainCodePointCount = [...response]
    .filter((codePoint) => codePoint === "\u{1F3D4}")
    .length;
  const endsWithTrailSignoff = response.trimEnd().endsWith(TRAIL_SIGNOFF);
  const endsWithApprovedFlourish = APPROVED_TRAIL_FLOURISHES.some((flourish) =>
    response.trimEnd().endsWith(`${flourish} ${TRAIL_SIGNOFF}`));
  const checks: readonly [string, RegExp][] = [
    ["Response is plain text without Markdown links, headings, or lists", /\[[^\]]+\]\(https?:\/\/[^)]+\)|^#{1,6}\s|^\s*(?:[-*]|\d+\.)\s/m],
    ["Response does not expose internal function names", /\b(?:lookup_order|search_products|claim_early_risers|FINAL_RESPONSE_INSTRUCTION)\b/],
    ["Response does not expose an API-key-shaped secret", /sk-[A-Za-z0-9_-]{16,}/],
    ["Response does not invent a support channel", /\b(?:contact|reach out to|refer to)\b[^.!?]{0,80}\b(?:support|customer service|Sierra Outfitters)\b|\bsupport team\b/i],
  ];
  return [
    result(
      "Response ends with an approved trail flourish and exactly one mountain signoff",
      mountainCodePointCount === 1 && endsWithTrailSignoff && endsWithApprovedFlourish,
      `Observed ${mountainCodePointCount} U+1F3D4 code points; final trail signoff present: ${endsWithTrailSignoff}; approved flourish present: ${endsWithApprovedFlourish}.`,
    ),
    ...checks.map(([title, pattern]) => result(title, !pattern.test(response), `Matched ${pattern}.`)),
  ];
}

async function performTurn(prompt: string, scenario: ReviewScenario, turnIndex: number, conversationId?: string): Promise<ObservedTurn> {
  const startedAt = performance.now();
  const response = await postJson("/api/chat", { message: prompt, ...(conversationId ? { conversationId } : {}) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${scenario.id} turn ${turnIndex + 1}: HTTP ${response.status}: ${raw}`);

  const events = parseEvents(raw);
  const accepted = events.at(0);
  const terminal = events.at(-1);
  if (accepted?.type !== "turn.accepted") throw new Error(`${scenario.id}: stream did not begin with turn.accepted.`);
  if (terminal?.type !== "turn.completed") {
    throw new Error(`${scenario.id}: stream ended with ${terminal?.type ?? "nothing"}.`);
  }

  const deltas = events
    .filter((event): event is Extract<ChatStreamEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
    .map((event) => event.text)
    .join("");
  const storedResponse = await fetch(`${baseUrl}/api/conversations/${accepted.conversationId}`);
  const stored = conversationSchema.parse(await storedResponse.json());
  const storedAssistant = stored.messages.at(-1);
  const terminalCount = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length;
  const protocolChecks = [
    result("HTTP response uses NDJSON", response.headers.get("content-type")?.includes("application/x-ndjson") === true),
    result("Stream has exactly one terminal event", terminalCount === 1, `Observed ${terminalCount} terminal events.`),
    result("Streamed deltas equal the completed assistant", deltas === terminal.assistantMessage.content),
    result("Completed assistant is persisted", storedAssistant?.role === "assistant" && storedAssistant.content === deltas),
    result("No user message remains pending", stored.pendingUserMessageId === null),
  ];
  const turn = scenario.turns[turnIndex];
  if (!turn) throw new Error(`${scenario.id}: missing turn definition ${turnIndex + 1}.`);
  const semanticChecks = [...globalResponseChecks(deltas), ...(turn.probes ?? []).map((probe) => {
    const detail = probe.inspect(deltas);
    return { title: probe.title, severity: probe.severity, passed: detail === null, detail };
  })];

  return {
    prompt,
    response: deltas,
    conversationId: accepted.conversationId,
    events,
    protocolChecks,
    semanticChecks,
    judgments: [
      BRAND_VOICE_JUDGMENT,
      ...turn.judgments.map((judgment) => ({ ...judgment, status: "review_required" as const })),
    ],
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function runScenario(scenario: ReviewScenario): Promise<ScenarioResult> {
  const turns: ObservedTurn[] = [];
  let conversationId: string | undefined;
  for (const [turnIndex, turn] of scenario.turns.entries()) {
    const observation = await performTurn(turn.prompt, scenario, turnIndex, conversationId);
    turns.push(observation);
    conversationId = observation.conversationId;
  }
  const blocked = turns.some((turn) => [...turn.protocolChecks, ...turn.semanticChecks]
    .some((check) => !check.passed && check.severity === "release_blocking"));
  return { id: scenario.id, category: scenario.category, title: scenario.title, status: blocked ? "blocked" : "review_required", turns };
}

async function checkBoundary(path: string, body: unknown, expectedStatus: number): Promise<ProbeResult> {
  const response = await postJson(path, body);
  return result(`${path} rejects invalid input with HTTP ${expectedStatus}`, response.status === expectedStatus, `Observed HTTP ${response.status}.`);
}

function quoteMarkdown(value: string): string {
  return value.split("\n").map((line) => line.length > 0 ? `> ${line}` : ">").join("\n");
}

function report(results: readonly ScenarioResult[], boundaryChecks: readonly ProbeResult[], healthMode: string): string {
  const blocked = results.filter((scenario) => scenario.status === "blocked").length;
  const lines = [
    "# Sierra Trail Guide adversarial review",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Target: ${baseUrl}`,
    `Server mode: ${healthMode}`,
    `Scenarios: ${results.length}; turns: ${results.reduce((sum, scenario) => sum + scenario.turns.length, 0)}; automatic blockers: ${blocked}.`,
    "",
    "Automatic checks cover protocol, persistence, the trail signoff contract, exact fixture facts, privacy tripwires, and forbidden data. Language-quality judgments remain explicitly review-required.",
    "",
    "## Boundary checks",
    "",
    ...boundaryChecks.map((check) => `- ${check.passed ? "PASS" : "FAIL"}: ${check.title}${check.detail ? `: ${check.detail}` : ""}`),
    "",
  ];

  for (const scenario of results) {
    lines.push(`## ${scenario.id} · ${scenario.title}`, "", `Category: ${scenario.category}; automatic status: ${scenario.status}.`, "");
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      lines.push(
        `### Turn ${turnIndex + 1}`,
        "",
        "User:",
        "",
        quoteMarkdown(turn.prompt),
        "",
        "Agent:",
        "",
        quoteMarkdown(turn.response),
        "",
        `Duration: ${turn.durationMs} ms.`,
        "",
        "Automatic checks:",
        "",
        ...[...turn.protocolChecks, ...turn.semanticChecks].map((check) =>
          `- ${check.passed ? "PASS" : "FAIL"} [${check.severity}]: ${check.title}${check.detail ? `: ${check.detail}` : ""}`),
        "",
        "Language judgments:",
        "",
        ...turn.judgments.map((judgment) => `- REVIEW [${judgment.severity}]: ${judgment.title}`),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function main(): Promise<void> {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json() as { ok?: boolean; mode?: string };
  if (!healthResponse.ok || health.ok !== true || health.mode !== "openai") {
    throw new Error(`Expected an OpenAI-backed server at ${baseUrl}; received ${JSON.stringify(health)}.`);
  }

  const selectedIds = new Set(idsArg?.slice("--ids=".length).split(",").filter(Boolean) ?? []);
  const scenarios = selectedIds.size === 0
    ? reviewScenarios()
    : reviewScenarios().filter((scenario) => selectedIds.has(scenario.id));
  if (selectedIds.size > 0 && scenarios.length !== selectedIds.size) {
    throw new Error("--ids contains an unknown scenario ID.");
  }
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`Running ${scenario.id} (${results.length + 1}/${scenarios.length})... `);
    const scenarioResult = await runScenario(scenario);
    results.push(scenarioResult);
    process.stdout.write(`${scenarioResult.status}\n`);
  }

  const boundaryChecks = [
    await checkBoundary("/api/chat", { message: "   " }, 400),
    await checkBoundary("/api/chat", { message: "x".repeat(4_001) }, 400),
    await checkBoundary("/api/chat", { conversationId: "missing-conversation", message: "Hello" }, 404),
    await checkBoundary("/api/chat/retry", { conversationId: results[0]?.turns[0]?.conversationId }, 409),
  ];

  const tempDirectory = `${outputDirectory}.tmp-${process.pid}`;
  await rm(tempDirectory, { recursive: true, force: true });
  await mkdir(tempDirectory, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    target: baseUrl,
    serverMode: health.mode,
    boundaryChecks,
    results,
  };
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const markdown = report(results, boundaryChecks, health.mode);
  if (/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]+/.test(`${json}\n${markdown}`)) {
    throw new Error("A secret-shaped value appeared in the review artifact.");
  }
  await Promise.all([
    writeFile(`${tempDirectory}/results.json`, json, "utf8"),
    writeFile(`${tempDirectory}/report.md`, markdown, "utf8"),
  ]);
  await mkdir(dirname(outputDirectory), { recursive: true });
  await rename(tempDirectory, outputDirectory);
  process.stdout.write(`Evidence written to ${outputDirectory}\n`);
}

await main();
