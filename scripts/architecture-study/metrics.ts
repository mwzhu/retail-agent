import {
  planningStrategies,
  scalarMetricNames,
  toolSpecVersions,
  type ArgumentExpectation,
  type CallRequirement,
  type FactorDelta,
  type GoldScenario,
  type GoldTurn,
  type MetricDirection,
  type OutcomeExpectation,
  type ObservedToolCall,
  type ObservedTurnTrace,
  type PlanningStrategy,
  type RateMetric,
  type ScalarMetricName,
  type ScoreSummary,
  type StudyCellObservation,
  type StudyMatrix,
  type ToolArgumentMap,
  type ToolName,
  type ToolOutcomeMap,
  type ToolSpecVersion,
} from "./types";

interface GoldTurnReference {
  readonly scenarioId: string;
  readonly turnIndex: number;
  readonly turn: GoldTurn;
}

interface RequirementSlot {
  readonly requirement: CallRequirement;
  readonly slotIndex: number;
}

interface TurnScore {
  readonly requiredCalls: number;
  readonly matchedRequiredTools: number;
  readonly observedCalls: number;
  readonly correctlyMatchedArguments: number;
  readonly correctlyMatchedOutcomes: number;
  readonly exactTrace: boolean;
  readonly isNoTool: boolean;
  readonly noToolCorrect: boolean;
  readonly dependencyEdges: number;
  readonly satisfiedDependencies: number;
  readonly duplicateCalls: number;
  readonly unsafeClaimApplicable: boolean;
  readonly unsafeClaimViolation: boolean;
  readonly responseProbeCount: number;
  readonly responseProbePasses: number;
  readonly isMultiIntent: boolean;
  readonly multiIntentComplete: boolean;
}

const metricDirections: Readonly<Record<ScalarMetricName, MetricDirection>> = {
  requiredCallRecall: "higher",
  precision: "higher",
  exactTracePass: "higher",
  noToolAccuracy: "higher",
  argumentAccuracy: "higher",
  outcomeAccuracy: "higher",
  dependencyAccuracy: "higher",
  duplicateRate: "lower",
  unsafeClaimRate: "lower",
  multiIntentCompletion: "higher",
  responseAccuracy: "higher",
  modelCallsPerTurn: "lower",
  latencyP50Ms: "lower",
  latencyP95Ms: "lower",
  timeToFirstTokenP50Ms: "lower",
  timeToFirstTokenP95Ms: "lower",
  planningLatencyP50Ms: "lower",
  planningLatencyP95Ms: "lower",
  toolExecutionLatencyP50Ms: "lower",
  toolExecutionLatencyP95Ms: "lower",
  finalResponseLatencyP50Ms: "lower",
  finalResponseLatencyP95Ms: "lower",
};

function rate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
}

function turnKey(scenarioId: string, turnIndex: number): string {
  return `${scenarioId}/${turnIndex}`;
}

function flattenCorpus(corpus: readonly GoldScenario[]): readonly GoldTurnReference[] {
  return corpus.flatMap((scenario) => scenario.turns.map((turn, turnIndex) => ({
    scenarioId: scenario.id,
    turnIndex,
    turn,
  })));
}

function requirementSlots(requirements: readonly CallRequirement[]): readonly RequirementSlot[] {
  return requirements.flatMap((requirement) =>
    Array.from({ length: requirement.count }, (_, slotIndex) => ({ requirement, slotIndex })));
}

function argumentsMatch<Name extends ToolName>(
  expectation: ArgumentExpectation<ToolArgumentMap[Name]>,
  observed: ToolArgumentMap[Name],
  exactMatch: (
    expected: ToolArgumentMap[Name],
    actual: ToolArgumentMap[Name],
  ) => boolean,
): boolean {
  return expectation.kind === "exact"
    ? exactMatch(expectation.value, observed)
    : expectation.matches(observed);
}

function callMatchesRequirement(call: ObservedToolCall, requirement: CallRequirement): boolean {
  if (call.tool !== requirement.tool) return false;
  switch (requirement.tool) {
    case "lookup_order":
      return call.tool === "lookup_order"
        && argumentsMatch<"lookup_order">(
          requirement.arguments,
          call.arguments,
          (expected, actual) =>
            expected.email === actual.email && expected.orderNumber === actual.orderNumber,
        );
    case "search_products":
      return call.tool === "search_products"
        && argumentsMatch<"search_products">(
          requirement.arguments,
          call.arguments,
          (expected, actual) =>
            expected.query === actual.query
            && expected.excludePurchasedItems === actual.excludePurchasedItems,
        );
    case "claim_early_risers":
      return call.tool === "claim_early_risers"
        && argumentsMatch<"claim_early_risers">(
          requirement.arguments,
          call.arguments,
          (_, actual) => Object.keys(actual).length === 0,
        );
  }
}

function outcomesEqual<Name extends ToolName>(
  expected: ToolOutcomeMap[Name],
  actual: ToolOutcomeMap[Name],
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function outcomeMatches<Outcome>(
  expectation: OutcomeExpectation<Outcome>,
  observed: Outcome,
  exactMatch: (expected: Outcome, actual: Outcome) => boolean,
): boolean {
  return expectation.kind === "exact"
    ? exactMatch(expectation.value, observed)
    : expectation.matches(observed);
}

function callOutcomeMatchesRequirement(
  call: ObservedToolCall,
  requirement: CallRequirement,
): boolean {
  if (call.tool !== requirement.tool || call.outcome.tool !== call.tool) return false;
  switch (requirement.tool) {
    case "lookup_order":
      return call.tool === "lookup_order"
        && outcomeMatches(
          requirement.outcome,
          call.outcome,
          outcomesEqual<"lookup_order">,
        );
    case "search_products":
      return call.tool === "search_products"
        && outcomeMatches(
          requirement.outcome,
          call.outcome,
          outcomesEqual<"search_products">,
        );
    case "claim_early_risers":
      return call.tool === "claim_early_risers"
        && outcomeMatches(
          requirement.outcome,
          call.outcome,
          outcomesEqual<"claim_early_risers">,
        );
  }
}

function maximumArgumentMatching(
  slots: readonly RequirementSlot[],
  calls: readonly ObservedToolCall[],
): ReadonlyMap<number, number> {
  const callToSlot = new Map<number, number>();

  function assign(slotIndex: number, visitedCalls: Set<number>): boolean {
    const slot = slots[slotIndex];
    if (!slot) return false;
    for (const [callIndex, call] of calls.entries()) {
      if (visitedCalls.has(callIndex) || !callMatchesRequirement(call, slot.requirement)) continue;
      visitedCalls.add(callIndex);
      const previousSlot = callToSlot.get(callIndex);
      if (previousSlot === undefined || assign(previousSlot, visitedCalls)) {
        callToSlot.set(callIndex, slotIndex);
        return true;
      }
    }
    return false;
  }

  for (const slotIndex of slots.keys()) assign(slotIndex, new Set());
  return new Map([...callToSlot.entries()].map(([callIndex, slotIndex]) => [slotIndex, callIndex]));
}

function countByTool(calls: readonly { readonly tool: ToolName }[]): ReadonlyMap<ToolName, number> {
  const counts = new Map<ToolName, number>();
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  return counts;
}

function scoreTurn(gold: GoldTurn, observed: ObservedTurnTrace): TurnScore {
  const slots = requirementSlots(gold.requiredCalls);
  const expectedCounts = countByTool(slots.map(({ requirement }) => requirement));
  const observedCounts = countByTool(observed.calls);
  const matchedRequiredTools = [...expectedCounts.entries()].reduce(
    (sum, [tool, count]) => sum + Math.min(count, observedCounts.get(tool) ?? 0),
    0,
  );
  const assignments = maximumArgumentMatching(slots, observed.calls);
  const correctlyMatchedOutcomes = [...assignments.entries()].filter(([slotIndex, callIndex]) => {
    const slot = slots[slotIndex];
    const call = observed.calls[callIndex];
    return slot !== undefined
      && call !== undefined
      && callOutcomeMatchesRequirement(call, slot.requirement);
  }).length;
  const forbiddenCallObserved = observed.calls.some((call) => gold.forbiddenCalls.includes(call.tool));
  const countsExact = [...new Set([...expectedCounts.keys(), ...observedCounts.keys()])]
    .every((tool) => (expectedCounts.get(tool) ?? 0) === (observedCounts.get(tool) ?? 0));
  const duplicateCalls = [...observedCounts.entries()].reduce((sum, [tool, count]) => {
    const allowedBeforeDuplicate = Math.max(expectedCounts.get(tool) ?? 0, 1);
    return sum + Math.max(0, count - allowedBeforeDuplicate);
  }, 0);
  const satisfiedDependencies = gold.dependencies.filter((edge) => {
    const beforeSlot = slots.findIndex(({ requirement }) =>
      requirement.id === edge.beforeRequirementId);
    const afterSlot = slots.findIndex(({ requirement }) =>
      requirement.id === edge.afterRequirementId);
    const beforeCall = observed.calls[assignments.get(beforeSlot) ?? -1];
    const afterCall = observed.calls[assignments.get(afterSlot) ?? -1];
    return beforeCall !== undefined && afterCall !== undefined && beforeCall.wave < afterCall.wave;
  }).length;
  const responseProbePasses = gold.responseProbes.filter((probe) =>
    probe.inspect(observed.response) === null).length;
  const unsafeClaimApplicable = gold.forbiddenCalls.includes("claim_early_risers");
  const unsafeClaimViolation = unsafeClaimApplicable && observed.calls.some((call) =>
    call.tool === "claim_early_risers");
  const isMultiIntent = new Set(gold.requiredCalls.map((call) => call.tool)).size > 1;
  const argumentsComplete = assignments.size === slots.length;
  const outcomesComplete = correctlyMatchedOutcomes === slots.length;
  const dependenciesComplete = satisfiedDependencies === gold.dependencies.length;
  const responseComplete = responseProbePasses === gold.responseProbes.length;
  const noUnexpectedCalls = countsExact && !forbiddenCallObserved;

  return {
    requiredCalls: slots.length,
    matchedRequiredTools,
    observedCalls: observed.calls.length,
    correctlyMatchedArguments: assignments.size,
    correctlyMatchedOutcomes,
    exactTrace: noUnexpectedCalls && argumentsComplete && outcomesComplete && dependenciesComplete,
    isNoTool: slots.length === 0,
    noToolCorrect: slots.length === 0 && observed.calls.length === 0,
    dependencyEdges: gold.dependencies.length,
    satisfiedDependencies,
    duplicateCalls,
    unsafeClaimApplicable,
    unsafeClaimViolation,
    responseProbeCount: gold.responseProbes.length,
    responseProbePasses,
    isMultiIntent,
    multiIntentComplete:
      isMultiIntent
      && noUnexpectedCalls
      && argumentsComplete
      && outcomesComplete
      && dependenciesComplete
      && responseComplete,
  };
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  if (percentileValue < 0 || percentileValue > 1) {
    throw new RangeError("Percentile must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function scoreCorpus(
  corpus: readonly GoldScenario[],
  traces: readonly ObservedTurnTrace[],
): ScoreSummary {
  const goldTurns = flattenCorpus(corpus);
  const goldByKey = new Map(goldTurns.map((reference) => [
    turnKey(reference.scenarioId, reference.turnIndex),
    reference,
  ]));
  const observedByKey = new Map<string, ObservedTurnTrace>();
  const repetitions = new Set<number>();
  for (const trace of traces) {
    const goldKey = turnKey(trace.scenarioId, trace.turnIndex);
    const key = `${trace.repetition}/${goldKey}`;
    if (!goldByKey.has(goldKey)) throw new Error(`Observed trace has unknown turn ${goldKey}.`);
    if (!Number.isInteger(trace.repetition) || trace.repetition < 0) {
      throw new Error(`Observed trace has invalid repetition for ${goldKey}.`);
    }
    if (observedByKey.has(key)) throw new Error(`Observed trace repeats turn ${key}.`);
    const timingValues = Object.values(trace.latency);
    if (timingValues.some((value) => value < 0 || !Number.isFinite(value))) {
      throw new Error(`Observed trace has invalid latency for ${key}.`);
    }
    if (trace.latency.timeToFirstTokenMs > trace.latency.totalMs) {
      throw new Error(`Observed trace has time to first token after completion for ${key}.`);
    }
    if (!Number.isInteger(trace.modelCallCount) || trace.modelCallCount < 0) {
      throw new Error(`Observed trace has invalid model-call count for ${key}.`);
    }
    const callIds = new Set<string>();
    for (const call of trace.calls) {
      if (
        call.callId.length === 0
        || !Number.isInteger(call.sequence)
        || call.sequence < 0
        || !Number.isInteger(call.wave)
        || call.wave < 0
      ) {
        throw new Error(`Observed trace has invalid call metadata for ${key}.`);
      }
      if (callIds.has(call.callId)) {
        throw new Error(`Observed trace repeats call ID ${call.callId} for ${key}.`);
      }
      callIds.add(call.callId);
    }
    observedByKey.set(key, trace);
    repetitions.add(trace.repetition);
  }
  if (repetitions.size === 0) throw new Error("At least one complete repetition is required.");
  const missing = [...repetitions].flatMap((repetition) =>
    [...goldByKey.keys()]
      .filter((key) => !observedByKey.has(`${repetition}/${key}`))
      .map((key) => `${repetition}/${key}`));
  if (missing.length > 0) throw new Error(`Missing observed turns: ${missing.join(", ")}.`);

  const scoredTurns = [...repetitions].flatMap((repetition) => goldTurns.map((reference) => {
    const observed = observedByKey.get(
      `${repetition}/${turnKey(reference.scenarioId, reference.turnIndex)}`,
    );
    if (!observed) throw new Error("Trace coverage changed during scoring.");
    return { score: scoreTurn(reference.turn, observed), observed };
  }));
  const turnScores = scoredTurns.map(({ score }) => score);
  const sum = (pick: (score: TurnScore) => number): number =>
    turnScores.reduce((total, score) => total + pick(score), 0);
  const noToolTurns = turnScores.filter((score) => score.isNoTool);
  const unsafeClaimTurns = turnScores.filter((score) => score.unsafeClaimApplicable);
  const multiIntentTurns = turnScores.filter((score) => score.isMultiIntent);
  const observedCallCount = sum((score) => score.observedCalls);
  const matchedToolCount = sum((score) => score.matchedRequiredTools);

  return {
    requiredCallRecall: rate(matchedToolCount, sum((score) => score.requiredCalls)),
    precision: rate(matchedToolCount, observedCallCount),
    exactTracePass: rate(sum((score) => Number(score.exactTrace)), turnScores.length),
    noToolAccuracy: rate(
      noToolTurns.filter((score) => score.noToolCorrect).length,
      noToolTurns.length,
    ),
    argumentAccuracy: rate(
      sum((score) => score.correctlyMatchedArguments),
      matchedToolCount,
    ),
    outcomeAccuracy: rate(
      sum((score) => score.correctlyMatchedOutcomes),
      sum((score) => score.correctlyMatchedArguments),
    ),
    dependencyAccuracy: rate(
      sum((score) => score.satisfiedDependencies),
      sum((score) => score.dependencyEdges),
    ),
    duplicateRate: rate(sum((score) => score.duplicateCalls), observedCallCount),
    unsafeClaimRate: rate(
      unsafeClaimTurns.filter((score) => score.unsafeClaimViolation).length,
      unsafeClaimTurns.length,
    ),
    multiIntentCompletion: rate(
      multiIntentTurns.filter((score) => score.multiIntentComplete).length,
      multiIntentTurns.length,
    ),
    responseAccuracy: rate(
      sum((score) => score.responseProbePasses),
      sum((score) => score.responseProbeCount),
    ),
    modelCallsPerTurn: scoredTurns.length === 0
      ? null
      : scoredTurns.reduce((total, { observed }) => total + observed.modelCallCount, 0)
        / scoredTurns.length,
    latencyP50Ms: percentile(traces.map((trace) => trace.latency.totalMs), 0.5),
    latencyP95Ms: percentile(traces.map((trace) => trace.latency.totalMs), 0.95),
    timeToFirstTokenP50Ms: percentile(
      traces.map((trace) => trace.latency.timeToFirstTokenMs),
      0.5,
    ),
    timeToFirstTokenP95Ms: percentile(
      traces.map((trace) => trace.latency.timeToFirstTokenMs),
      0.95,
    ),
    planningLatencyP50Ms: percentile(traces.map((trace) => trace.latency.planningMs), 0.5),
    planningLatencyP95Ms: percentile(traces.map((trace) => trace.latency.planningMs), 0.95),
    toolExecutionLatencyP50Ms: percentile(
      traces.map((trace) => trace.latency.toolExecutionMs),
      0.5,
    ),
    toolExecutionLatencyP95Ms: percentile(
      traces.map((trace) => trace.latency.toolExecutionMs),
      0.95,
    ),
    finalResponseLatencyP50Ms: percentile(
      traces.map((trace) => trace.latency.finalResponseMs),
      0.5,
    ),
    finalResponseLatencyP95Ms: percentile(
      traces.map((trace) => trace.latency.finalResponseMs),
      0.95,
    ),
  };
}

export function buildStudyMatrix(
  corpus: readonly GoldScenario[],
  cells: readonly StudyCellObservation[],
): StudyMatrix {
  const byCell = new Map<string, ScoreSummary>();
  for (const cell of cells) {
    const key = `${cell.strategy}/${cell.toolSpec}`;
    if (byCell.has(key)) throw new Error(`Duplicate study cell ${key}.`);
    byCell.set(key, scoreCorpus(corpus, cell.traces));
  }
  const score = (strategy: PlanningStrategy, toolSpec: ToolSpecVersion): ScoreSummary => {
    const value = byCell.get(`${strategy}/${toolSpec}`);
    if (!value) throw new Error(`Missing study cell ${strategy}/${toolSpec}.`);
    return value;
  };
  if (byCell.size !== planningStrategies.length * toolSpecVersions.length) {
    throw new Error("Study matrix must contain exactly one observation for every strategy and tool specification.");
  }
  return {
    auto: { current: score("auto", "current"), guided: score("auto", "guided") },
    sequence: { current: score("sequence", "current"), guided: score("sequence", "guided") },
    plan: { current: score("plan", "current"), guided: score("plan", "guided") },
  };
}

function scalarValue(summary: ScoreSummary, metric: ScalarMetricName): number | null {
  const value = summary[metric];
  return typeof value === "number" || value === null ? value : value.rate;
}

function delta(
  kind: FactorDelta["kind"],
  metric: ScalarMetricName,
  baselineCell: FactorDelta["baseline"],
  treatmentCell: FactorDelta["treatment"],
): FactorDelta {
  const rawDelta = treatmentCell.value - baselineCell.value;
  const direction = metricDirections[metric];
  return {
    kind,
    metric,
    direction,
    baseline: baselineCell,
    treatment: treatmentCell,
    rawDelta,
    improvement: direction === "higher" ? rawDelta : -rawDelta,
  };
}

function comparisonDelta(
  kind: FactorDelta["kind"],
  metric: ScalarMetricName,
  matrix: StudyMatrix,
  baseline: Readonly<{ strategy: PlanningStrategy; toolSpec: ToolSpecVersion }>,
  treatment: Readonly<{ strategy: PlanningStrategy; toolSpec: ToolSpecVersion }>,
): FactorDelta | null {
  const baselineValue = scalarValue(matrix[baseline.strategy][baseline.toolSpec], metric);
  const treatmentValue = scalarValue(matrix[treatment.strategy][treatment.toolSpec], metric);
  if (baselineValue === null || treatmentValue === null) return null;
  return delta(
    kind,
    metric,
    { ...baseline, value: baselineValue },
    { ...treatment, value: treatmentValue },
  );
}

export function factorDeltas(matrix: StudyMatrix): readonly FactorDelta[] {
  const deltas: FactorDelta[] = [];
  for (const metric of scalarMetricNames) {
    for (const toolSpec of toolSpecVersions) {
      for (const strategy of ["sequence", "plan"] as const) {
        const value = comparisonDelta(
          "architecture",
          metric,
          matrix,
          { strategy: "auto", toolSpec },
          { strategy, toolSpec },
        );
        if (value) deltas.push(value);
      }
    }
    for (const strategy of planningStrategies) {
      const value = comparisonDelta(
        "tool_spec",
        metric,
        matrix,
        { strategy, toolSpec: "current" },
        { strategy, toolSpec: "guided" },
      );
      if (value) deltas.push(value);
    }

    for (const strategy of ["sequence", "plan"] as const) {
      const autoCurrent = scalarValue(matrix.auto.current, metric);
      const autoGuided = scalarValue(matrix.auto.guided, metric);
      const strategyCurrent = scalarValue(matrix[strategy].current, metric);
      const strategyGuided = scalarValue(matrix[strategy].guided, metric);
      if (
        autoCurrent === null
        || autoGuided === null
        || strategyCurrent === null
        || strategyGuided === null
      ) continue;
      const rawDelta = (strategyGuided - strategyCurrent) - (autoGuided - autoCurrent);
      const direction = metricDirections[metric];
      deltas.push({
        kind: "interaction",
        metric,
        direction,
        baseline: { strategy: "auto", toolSpec: "guided", value: autoGuided - autoCurrent },
        treatment: {
          strategy,
          toolSpec: "guided",
          value: strategyGuided - strategyCurrent,
        },
        rawDelta,
        improvement: direction === "higher" ? rawDelta : -rawDelta,
      });
    }
  }
  return deltas;
}
