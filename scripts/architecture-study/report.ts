import { buildStudyMatrix, factorDeltas } from "./metrics";
import {
  scalarMetricNames,
  type FactorDelta,
  type GoldScenario,
  type RateMetric,
  type ScalarMetricName,
  type ScoreSummary,
  type StudyCellObservation,
  type StudyMatrix,
} from "./types";

function isRateMetric(value: RateMetric | number | null): value is RateMetric {
  return typeof value === "object" && value !== null && "rate" in value;
}

function formatValue(metric: ScalarMetricName, value: RateMetric | number | null): string {
  if (isRateMetric(value)) {
    return value.rate === null
      ? `n/a (${value.numerator}/${value.denominator})`
      : `${(value.rate * 100).toFixed(1)}% (${value.numerator}/${value.denominator})`;
  }
  if (value === null) return "n/a";
  return metric === "modelCallsPerTurn"
    ? value.toFixed(2)
    : `${value.toFixed(1)} ms`;
}

function formatDelta(delta: FactorDelta): string {
  const rateMetric = !delta.metric.toLocaleLowerCase().includes("latency")
    && !delta.metric.startsWith("timeToFirstToken")
    && delta.metric !== "modelCallsPerTurn";
  if (rateMetric) {
    return `${delta.improvement >= 0 ? "+" : ""}${(delta.improvement * 100).toFixed(1)} pp`;
  }
  const unit = delta.metric === "modelCallsPerTurn" ? " calls/turn" : " ms";
  return `${delta.improvement >= 0 ? "+" : ""}${delta.improvement.toFixed(2)}${unit}`;
}

function summaryRow(metric: ScalarMetricName, matrix: StudyMatrix): string {
  return [
    metric,
    formatValue(metric, matrix.auto.current[metric]),
    formatValue(metric, matrix.auto.guided[metric]),
    formatValue(metric, matrix.sequence.current[metric]),
    formatValue(metric, matrix.sequence.guided[metric]),
    formatValue(metric, matrix.plan.current[metric]),
    formatValue(metric, matrix.plan.guided[metric]),
  ].join(" | ");
}

export function renderStudyMarkdown(matrix: StudyMatrix): string {
  const deltas = factorDeltas(matrix);
  const architecture = deltas.filter((delta) => delta.kind === "architecture");
  const specifications = deltas.filter((delta) => delta.kind === "tool_spec");
  const interactions = deltas.filter((delta) => delta.kind === "interaction");
  const deltaRows = (values: readonly FactorDelta[]): readonly string[] => values.map((delta) => [
    delta.metric,
    `${delta.baseline.strategy}/${delta.baseline.toolSpec}`,
    `${delta.treatment.strategy}/${delta.treatment.toolSpec}`,
    formatDelta(delta),
  ].join(" | "));

  return `${[
    "# Agent architecture study",
    "",
    "## Cell scores",
    "",
    "Metric | auto/current | auto/guided | sequence/current | sequence/guided | plan/current | plan/guided",
    "--- | ---: | ---: | ---: | ---: | ---: | ---:",
    ...scalarMetricNames.map((metric) => summaryRow(metric, matrix)),
    "",
    "## Architecture deltas",
    "",
    "Metric | Baseline | Treatment | Improvement",
    "--- | --- | --- | ---:",
    ...deltaRows(architecture),
    "",
    "## Tool specification deltas",
    "",
    "Metric | Baseline | Treatment | Improvement",
    "--- | --- | --- | ---:",
    ...deltaRows(specifications),
    "",
    "## Interaction deltas",
    "",
    "Metric | Auto specification effect | Architecture specification effect | Improvement",
    "--- | --- | --- | ---:",
    ...deltaRows(interactions),
  ].join("\n")}\n`;
}

export function renderStudyJson(matrix: StudyMatrix): string {
  return `${JSON.stringify({ matrix, deltas: factorDeltas(matrix) }, null, 2)}\n`;
}

export function metricValue(summary: ScoreSummary, metric: ScalarMetricName): number | null {
  const value = summary[metric];
  return isRateMetric(value) ? value.rate : value;
}

export function renderStudyReport(
  corpus: readonly GoldScenario[],
  cells: readonly StudyCellObservation[],
): Readonly<{
  matrix: StudyMatrix;
  deltas: readonly FactorDelta[];
  markdown: string;
  json: string;
}> {
  const matrix = buildStudyMatrix(corpus, cells);
  return {
    matrix,
    deltas: factorDeltas(matrix),
    markdown: renderStudyMarkdown(matrix),
    json: renderStudyJson(matrix),
  };
}
