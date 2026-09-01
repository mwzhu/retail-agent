import type { Probe, ScenarioCategory } from "../agent-review/scenarios";

export const planningStrategies = ["auto", "sequence", "plan"] as const;
export const toolSpecVersions = ["current", "guided"] as const;

export type PlanningStrategy = (typeof planningStrategies)[number];
export type ToolSpecVersion = (typeof toolSpecVersions)[number];
export type ToolName = "lookup_order" | "search_products" | "claim_early_risers";

export interface ToolArgumentMap {
  readonly lookup_order: Readonly<{ email: string; orderNumber: string }>;
  readonly search_products: Readonly<{ query: string }>;
  readonly claim_early_risers: Readonly<Record<string, never>>;
}

export type ToolInvocation = {
  readonly [Name in ToolName]: Readonly<{
    tool: Name;
    arguments: ToolArgumentMap[Name];
  }>;
}[ToolName];

export type ArgumentExpectation<Arguments> =
  | Readonly<{ kind: "exact"; value: Arguments }>
  | Readonly<{
      kind: "predicate";
      description: string;
      sample: Arguments;
      matches: (arguments_: Arguments) => boolean;
    }>;

export type CallRequirement = {
  readonly [Name in ToolName]: Readonly<{
    id: string;
    tool: Name;
    count: number;
    arguments: ArgumentExpectation<ToolArgumentMap[Name]>;
  }>;
}[ToolName];

export interface DependencyEdge {
  readonly beforeRequirementId: string;
  readonly afterRequirementId: string;
}

export interface GoldTurn {
  readonly prompt: string;
  readonly requiredCalls: readonly CallRequirement[];
  readonly forbiddenCalls: readonly ToolName[];
  readonly dependencies: readonly DependencyEdge[];
  readonly responseProbes: readonly Probe[];
}

export interface GoldScenario {
  readonly id: string;
  readonly category: ScenarioCategory;
  readonly title: string;
  readonly turns: readonly GoldTurn[];
}

export type ObservedToolCall = ToolInvocation & Readonly<{
  callId: string;
  sequence: number;
  wave: number;
}>;

export interface ObservedTurnTrace {
  readonly scenarioId: string;
  readonly turnIndex: number;
  readonly repetition: number;
  readonly calls: readonly ObservedToolCall[];
  readonly response: string;
  readonly modelCallCount: number;
  readonly latency: Readonly<{
    totalMs: number;
    timeToFirstTokenMs: number;
    planningMs: number;
    toolExecutionMs: number;
    finalResponseMs: number;
  }>;
}

export interface StudyCellObservation {
  readonly strategy: PlanningStrategy;
  readonly toolSpec: ToolSpecVersion;
  readonly traces: readonly ObservedTurnTrace[];
}

export interface RateMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

export interface ScoreSummary {
  readonly requiredCallRecall: RateMetric;
  readonly precision: RateMetric;
  readonly exactTracePass: RateMetric;
  readonly noToolAccuracy: RateMetric;
  readonly argumentAccuracy: RateMetric;
  readonly dependencyAccuracy: RateMetric;
  readonly duplicateRate: RateMetric;
  readonly unsafeClaimRate: RateMetric;
  readonly multiIntentCompletion: RateMetric;
  readonly responseAccuracy: RateMetric;
  readonly modelCallsPerTurn: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly timeToFirstTokenP50Ms: number | null;
  readonly timeToFirstTokenP95Ms: number | null;
  readonly planningLatencyP50Ms: number | null;
  readonly planningLatencyP95Ms: number | null;
  readonly toolExecutionLatencyP50Ms: number | null;
  readonly toolExecutionLatencyP95Ms: number | null;
  readonly finalResponseLatencyP50Ms: number | null;
  readonly finalResponseLatencyP95Ms: number | null;
}

export type StudyMatrix = Readonly<{
  [Strategy in PlanningStrategy]: Readonly<{
    [Spec in ToolSpecVersion]: ScoreSummary;
  }>;
}>;

export type RateMetricName = {
  readonly [Name in keyof ScoreSummary]: ScoreSummary[Name] extends RateMetric ? Name : never;
}[keyof ScoreSummary];

export type ScalarMetricName = RateMetricName | Exclude<keyof ScoreSummary, RateMetricName>;
export type MetricDirection = "higher" | "lower";

export const scalarMetricNames = [
  "requiredCallRecall",
  "precision",
  "exactTracePass",
  "noToolAccuracy",
  "argumentAccuracy",
  "dependencyAccuracy",
  "duplicateRate",
  "unsafeClaimRate",
  "multiIntentCompletion",
  "responseAccuracy",
  "modelCallsPerTurn",
  "latencyP50Ms",
  "latencyP95Ms",
  "timeToFirstTokenP50Ms",
  "timeToFirstTokenP95Ms",
  "planningLatencyP50Ms",
  "planningLatencyP95Ms",
  "toolExecutionLatencyP50Ms",
  "toolExecutionLatencyP95Ms",
  "finalResponseLatencyP50Ms",
  "finalResponseLatencyP95Ms",
] as const satisfies readonly ScalarMetricName[];

export interface FactorDelta {
  readonly kind: "architecture" | "tool_spec" | "interaction";
  readonly metric: ScalarMetricName;
  readonly direction: MetricDirection;
  readonly baseline: Readonly<{
    strategy: PlanningStrategy;
    toolSpec: ToolSpecVersion;
    value: number;
  }>;
  readonly treatment: Readonly<{
    strategy: PlanningStrategy;
    toolSpec: ToolSpecVersion;
    value: number;
  }>;
  readonly rawDelta: number;
  readonly improvement: number;
}
