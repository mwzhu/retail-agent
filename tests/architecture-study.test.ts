import { describe, expect, it } from "vitest";
import {
  architectureStudyCorpus,
  architectureStudyGlobalResponseProbes,
} from "../scripts/architecture-study/corpus";
import {
  buildStudyMatrix,
  factorDeltas,
  percentile,
  scoreCorpus,
} from "../scripts/architecture-study/metrics";
import {
  renderStudyJson,
  renderStudyMarkdown,
  renderStudyReport,
} from "../scripts/architecture-study/report";
import type {
  CallRequirement,
  GoldScenario,
  ObservedToolCall,
  ObservedTurnTrace,
  PlanningStrategy,
  ScoreSummary,
  StudyCellObservation,
  ToolSpecVersion,
} from "../scripts/architecture-study/types";

function includes(value: string) {
  return {
    title: `Includes ${value}`,
    severity: "release_blocking" as const,
    inspect: (response: string) => response.includes(value) ? null : `Missing ${value}.`,
  };
}

const orderRequirement: CallRequirement = {
  id: "order",
  tool: "lookup_order",
  count: 1,
  arguments: {
    kind: "exact",
    value: { email: "john.doe@example.com", orderNumber: "W001" },
  },
  outcome: {
    kind: "exact",
    value: { tool: "lookup_order", kind: "found", itemSkus: [] },
  },
};

const searchRequirement: CallRequirement = {
  id: "products",
  tool: "search_products",
  count: 1,
  arguments: {
    kind: "predicate",
    description: "query mentions skis",
    sample: { query: "beginner skis", excludePurchasedItems: false },
    matches: ({ query }) => query.toLocaleLowerCase().includes("ski"),
  },
  outcome: {
    kind: "exact",
    value: {
      tool: "search_products",
      kind: "matches",
      productSkus: ["SOTN002"],
      excludedSkus: [],
    },
  },
};

const smallCorpus: readonly GoldScenario[] = [{
  id: "TEST-001",
  category: "unexpected",
  title: "Dependent multi-intent turn",
  turns: [{
    prompt: "Look up my order, then recommend skis.",
    requiredCalls: [orderRequirement, searchRequirement],
    forbiddenCalls: ["claim_early_risers"],
    dependencies: [{ beforeRequirementId: "order", afterRequirementId: "products" }],
    responseProbes: [includes("delivered"), includes("skis")],
  }],
}, {
  id: "TEST-002",
  category: "unexpected",
  title: "No-tool safety turn",
  turns: [{
    prompt: "Refund my order.",
    requiredCalls: [],
    forbiddenCalls: ["lookup_order", "search_products", "claim_early_risers"],
    dependencies: [],
    responseProbes: [],
  }],
}];

type ObservedOrderCall = Extract<ObservedToolCall, { readonly tool: "lookup_order" }>;
type ObservedSearchCall = Extract<ObservedToolCall, { readonly tool: "search_products" }>;

function orderCall(
  overrides: Partial<Omit<ObservedOrderCall, "tool">> = {},
): ObservedOrderCall {
  return {
    tool: "lookup_order",
    arguments: { email: "john.doe@example.com", orderNumber: "W001" },
    callId: "order-call",
    sequence: 0,
    wave: 0,
    outcome: { tool: "lookup_order", kind: "found", itemSkus: [] },
    ...overrides,
  };
}

function searchCall(
  overrides: Partial<Omit<ObservedSearchCall, "tool">> = {},
): ObservedSearchCall {
  return {
    tool: "search_products",
    arguments: { query: "beginner skis", excludePurchasedItems: false },
    callId: "search-call",
    sequence: 1,
    wave: 1,
    outcome: {
      tool: "search_products",
      kind: "matches",
      productSkus: ["SOTN002"],
      excludedSkus: [],
    },
    ...overrides,
  };
}

function perfectTraces(repetition = 0, latencyOffset = 0): readonly ObservedTurnTrace[] {
  return [{
    scenarioId: "TEST-001",
    turnIndex: 0,
    repetition,
    calls: [orderCall(), searchCall()],
    response: "The order was delivered. I recommend the skis.",
    modelCallCount: 3,
    latency: {
      totalMs: 100 + latencyOffset,
      timeToFirstTokenMs: 80 + latencyOffset,
      planningMs: 40 + latencyOffset,
      toolExecutionMs: 10,
      finalResponseMs: 50,
    },
  }, {
    scenarioId: "TEST-002",
    turnIndex: 0,
    repetition,
    calls: [],
    response: "I can't issue a refund here.",
    modelCallCount: 2,
    latency: {
      totalMs: 300 + latencyOffset,
      timeToFirstTokenMs: 240 + latencyOffset,
      planningMs: 100 + latencyOffset,
      toolExecutionMs: 0,
      finalResponseMs: 200,
    },
  }];
}

function scoreWithValue(value: number): ScoreSummary {
  const metric = { numerator: value, denominator: 1, rate: value };
  return {
    requiredCallRecall: metric,
    precision: metric,
    exactTracePass: metric,
    noToolAccuracy: metric,
    argumentAccuracy: metric,
    outcomeAccuracy: metric,
    dependencyAccuracy: metric,
    duplicateRate: metric,
    unsafeClaimRate: metric,
    multiIntentCompletion: metric,
    responseAccuracy: metric,
    modelCallsPerTurn: value,
    latencyP50Ms: value * 1_000,
    latencyP95Ms: value * 2_000,
    timeToFirstTokenP50Ms: value * 900,
    timeToFirstTokenP95Ms: value * 1_800,
    planningLatencyP50Ms: value * 400,
    planningLatencyP95Ms: value * 800,
    toolExecutionLatencyP50Ms: value * 100,
    toolExecutionLatencyP95Ms: value * 200,
    finalResponseLatencyP50Ms: value * 500,
    finalResponseLatencyP95Ms: value * 1_000,
  };
}

describe("architecture study corpus", () => {
  it("covers every original turn and the organic routing matrix", () => {
    const corpus = architectureStudyCorpus();
    const turns = corpus.flatMap((scenario) => scenario.turns);
    const requiredCalls = turns.flatMap((turn) =>
      turn.requiredCalls.flatMap((call) => Array.from({ length: call.count }, () => call)));

    expect(corpus).toHaveLength(41);
    expect(turns).toHaveLength(45);
    expect(corpus.filter((scenario) => scenario.id.startsWith("RTE-"))).toHaveLength(10);
    expect(requiredCalls).toHaveLength(38);
    expect(turns.filter((turn) => turn.requiredCalls.length === 0)).toHaveLength(13);
    expect(turns.filter((turn) => new Set(turn.requiredCalls.map((call) => call.tool)).size > 1))
      .toHaveLength(5);
    expect(turns.flatMap((turn) => turn.dependencies)).toHaveLength(1);
    expect(architectureStudyGlobalResponseProbes()).toHaveLength(4);
    expect(turns.every((turn) => architectureStudyGlobalResponseProbes().every((globalProbe) =>
      turn.responseProbes.some((probe) => probe.title === globalProbe.title)))).toBe(true);
  });

  it("keeps candidate-facing prompts organic", () => {
    const prompts = architectureStudyCorpus().flatMap((scenario) =>
      scenario.turns.map((turn) => turn.prompt));
    const prohibited = /\b(?:eval|evaluation|test|judge|experiment|rubric|score|benchmark|candidate|arena)\b/i;

    expect(prompts.filter((prompt) => prohibited.test(prompt))).toEqual([]);
  });
});

describe("architecture study scoring", () => {
  it("scores a complete trace on one consistent scale", () => {
    const score = scoreCorpus(smallCorpus, perfectTraces());

    expect(score.requiredCallRecall).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(score.precision.rate).toBe(1);
    expect(score.exactTracePass.rate).toBe(1);
    expect(score.noToolAccuracy.rate).toBe(1);
    expect(score.argumentAccuracy.rate).toBe(1);
    expect(score.outcomeAccuracy.rate).toBe(1);
    expect(score.dependencyAccuracy.rate).toBe(1);
    expect(score.duplicateRate.rate).toBe(0);
    expect(score.unsafeClaimRate.rate).toBe(0);
    expect(score.multiIntentCompletion.rate).toBe(1);
    expect(score.responseAccuracy.rate).toBe(1);
    expect(score.modelCallsPerTurn).toBe(2.5);
    expect(score.latencyP50Ms).toBe(200);
    expect(score.latencyP95Ms).toBe(290);
    expect(score.timeToFirstTokenP50Ms).toBe(160);
    expect(score.planningLatencyP50Ms).toBe(70);
  });

  it("fails exact traces when a selected capability returns the wrong outcome", () => {
    const traces = perfectTraces().map((trace) => trace.scenarioId === "TEST-001"
      ? {
          ...trace,
          calls: trace.calls.map((call) => call.tool === "lookup_order"
            ? {
                ...call,
                outcome: {
                  tool: "lookup_order" as const,
                  kind: "not_found" as const,
                  itemSkus: [],
                },
              }
            : call),
        }
      : trace);

    const score = scoreCorpus(smallCorpus, traces);

    expect(score.requiredCallRecall.rate).toBe(1);
    expect(score.argumentAccuracy.rate).toBe(1);
    expect(score.outcomeAccuracy.rate).toBe(0.5);
    expect(score.exactTracePass.rate).toBe(0.5);
  });

  it("separates selection, arguments, ordering, duplication, safety, and response quality", () => {
    const traces: readonly ObservedTurnTrace[] = [{
      scenarioId: "TEST-001",
      turnIndex: 0,
      repetition: 0,
      calls: [
        orderCall(),
        orderCall({ callId: "duplicate-order", sequence: 1 }),
        searchCall({
          arguments: { query: "camping", excludePurchasedItems: false },
          sequence: 2,
          wave: 0,
        }),
      ],
      response: "The order was delivered. I recommend the skis.",
      modelCallCount: 3,
      latency: {
        totalMs: 100,
        timeToFirstTokenMs: 80,
        planningMs: 40,
        toolExecutionMs: 10,
        finalResponseMs: 50,
      },
    }, {
      scenarioId: "TEST-002",
      turnIndex: 0,
      repetition: 0,
      calls: [{
        tool: "claim_early_risers",
        arguments: {},
        callId: "unexpected-claim",
        sequence: 0,
        wave: 0,
        outcome: { tool: "claim_early_risers", kind: "outside_window" },
      }],
      response: "Your refund issued confirmation is ready.",
      modelCallCount: 2,
      latency: {
        totalMs: 300,
        timeToFirstTokenMs: 240,
        planningMs: 100,
        toolExecutionMs: 0,
        finalResponseMs: 200,
      },
    }];

    const score = scoreCorpus(smallCorpus, traces);

    expect(score.requiredCallRecall.rate).toBe(1);
    expect(score.precision.rate).toBe(0.5);
    expect(score.exactTracePass.rate).toBe(0);
    expect(score.noToolAccuracy.rate).toBe(0);
    expect(score.argumentAccuracy.rate).toBe(0.5);
    expect(score.dependencyAccuracy.rate).toBe(0);
    expect(score.duplicateRate.rate).toBe(0.25);
    expect(score.unsafeClaimRate.rate).toBe(0.5);
    expect(score.multiIntentCompletion.rate).toBe(0);
    expect(score.responseAccuracy.rate).toBe(1);
  });

  it("does not count a missed tool again as an argument failure", () => {
    const traces = perfectTraces().map((trace) => trace.scenarioId === "TEST-001"
      ? { ...trace, calls: [orderCall()] }
      : trace);

    const score = scoreCorpus(smallCorpus, traces);

    expect(score.requiredCallRecall.rate).toBe(0.5);
    expect(score.argumentAccuracy).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("uses maximum matching when argument predicates overlap", () => {
    const flexibleSearch: CallRequirement = {
      id: "flexible",
      tool: "search_products",
      count: 1,
      arguments: {
        kind: "predicate",
        description: "any non-empty query",
        sample: { query: "gear", excludePurchasedItems: false },
        matches: ({ query }) => query.length > 0,
      },
      outcome: searchRequirement.outcome,
    };
    const overlapCorpus: readonly GoldScenario[] = [{
      id: "MATCH-001",
      category: "product",
      title: "Overlapping predicates",
      turns: [{
        prompt: "Show me skis and other gear.",
        requiredCalls: [flexibleSearch, searchRequirement],
        forbiddenCalls: ["lookup_order", "claim_early_risers"],
        dependencies: [],
        responseProbes: [],
      }],
    }];
    const traces: readonly ObservedTurnTrace[] = [{
      scenarioId: "MATCH-001",
      turnIndex: 0,
      repetition: 0,
      calls: [
        searchCall({
          callId: "ski",
          arguments: { query: "skis", excludePurchasedItems: false },
        }),
        searchCall({
          callId: "gear",
          arguments: { query: "gear", excludePurchasedItems: false },
        }),
      ],
      response: "",
      modelCallCount: 2,
      latency: {
        totalMs: 1,
        timeToFirstTokenMs: 1,
        planningMs: 1,
        toolExecutionMs: 0,
        finalResponseMs: 0,
      },
    }];

    expect(scoreCorpus(overlapCorpus, traces).argumentAccuracy.rate).toBe(1);
  });

  it("rejects missing, duplicate, and unknown observations", () => {
    const traceToDuplicate = perfectTraces().at(0);
    if (!traceToDuplicate) throw new Error("Test fixture must have one trace.");
    expect(() => scoreCorpus(smallCorpus, perfectTraces().slice(0, 1)))
      .toThrow(/Missing observed turns/);
    expect(() => scoreCorpus(smallCorpus, [...perfectTraces(), traceToDuplicate]))
      .toThrow(/repeats turn/);
    expect(() => scoreCorpus(smallCorpus, [
      ...perfectTraces(),
      {
        scenarioId: "UNKNOWN",
        turnIndex: 0,
        repetition: 0,
        calls: [],
        response: "",
        modelCallCount: 1,
        latency: {
          totalMs: 1,
          timeToFirstTokenMs: 1,
          planningMs: 0,
          toolExecutionMs: 0,
          finalResponseMs: 1,
        },
      },
    ])).toThrow(/unknown turn/);
  });

  it("aggregates complete repeated runs without key collisions", () => {
    const score = scoreCorpus(smallCorpus, [
      ...perfectTraces(0),
      ...perfectTraces(1, 100),
    ]);

    expect(score.requiredCallRecall).toEqual({ numerator: 4, denominator: 4, rate: 1 });
    expect(score.exactTracePass).toEqual({ numerator: 4, denominator: 4, rate: 1 });
    expect(score.latencyP50Ms).toBe(250);
  });

  it("computes linearly interpolated percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([0, 100], 0.95)).toBe(95);
    expect(() => percentile([1], 1.1)).toThrow(RangeError);
  });
});

describe("3x2 factor analysis", () => {
  function matrix() {
    return {
      auto: { current: scoreWithValue(0.5), guided: scoreWithValue(0.6) },
      sequence: { current: scoreWithValue(0.65), guided: scoreWithValue(0.72) },
      plan: { current: scoreWithValue(0.7), guided: scoreWithValue(0.9) },
    } as const;
  }

  it("reports architecture, specification, and interaction effects", () => {
    const deltas = factorDeltas(matrix());
    const planArchitecture = deltas.find((delta) =>
      delta.kind === "architecture"
      && delta.metric === "requiredCallRecall"
      && delta.treatment.strategy === "plan"
      && delta.treatment.toolSpec === "current");
    const autoSpecification = deltas.find((delta) =>
      delta.kind === "tool_spec"
      && delta.metric === "requiredCallRecall"
      && delta.baseline.strategy === "auto");
    const planInteraction = deltas.find((delta) =>
      delta.kind === "interaction"
      && delta.metric === "requiredCallRecall"
      && delta.treatment.strategy === "plan");
    const lowerLatency = deltas.find((delta) =>
      delta.kind === "architecture"
      && delta.metric === "latencyP50Ms"
      && delta.treatment.strategy === "plan"
      && delta.treatment.toolSpec === "current");

    expect(planArchitecture?.improvement).toBeCloseTo(0.2);
    expect(autoSpecification?.improvement).toBeCloseTo(0.1);
    expect(planInteraction?.improvement).toBeCloseTo(0.1);
    expect(lowerLatency?.improvement).toBe(-200);
  });

  it("requires all six cells exactly once", () => {
    const cells: StudyCellObservation[] = [];
    for (const strategy of ["auto", "sequence", "plan"] satisfies readonly PlanningStrategy[]) {
      for (const toolSpec of ["current", "guided"] satisfies readonly ToolSpecVersion[]) {
        cells.push({ strategy, toolSpec, traces: perfectTraces() });
      }
    }
    const studyMatrix = buildStudyMatrix(smallCorpus, cells);
    const duplicateCell = cells.at(0);
    if (!duplicateCell) throw new Error("Test fixture must have one cell.");

    expect(studyMatrix.plan.guided.requiredCallRecall.rate).toBe(1);
    expect(renderStudyReport(smallCorpus, cells).markdown).toContain("auto/current");
    expect(() => buildStudyMatrix(smallCorpus, cells.slice(0, -1))).toThrow(/exactly one observation/);
    expect(() => buildStudyMatrix(smallCorpus, [...cells, duplicateCell])).toThrow(/Duplicate study cell/);
  });

  it("renders machine-readable and human-readable reports", () => {
    const markdown = renderStudyMarkdown(matrix());
    const json = renderStudyJson(matrix());

    expect(markdown).toContain("auto/current");
    expect(markdown).toContain("## Interaction deltas");
    expect(JSON.parse(json)).toMatchObject({
      matrix: { plan: { guided: { requiredCallRecall: { rate: 0.9 } } } },
    });
  });
});
