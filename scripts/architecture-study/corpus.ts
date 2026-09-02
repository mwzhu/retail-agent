import {
  reviewScenarios,
  type Probe,
  type ReviewScenario,
  type ReviewTurn,
  type ScenarioCategory,
} from "../agent-review/scenarios";
import type {
  ArgumentExpectation,
  CallRequirement,
  GoldScenario,
  GoldTurn,
  OutcomeExpectation,
  ToolArgumentMap,
  ToolName,
  ToolOutcomeMap,
} from "./types";

const toolNames = ["lookup_order", "search_products", "claim_early_risers"] as const;

function exact<Arguments>(value: Arguments): ArgumentExpectation<Arguments> {
  return { kind: "exact", value };
}

function predicate<Arguments>(
  description: string,
  sample: Arguments,
  matches: (arguments_: Arguments) => boolean,
): ArgumentExpectation<Arguments> {
  return { kind: "predicate", description, sample, matches };
}

function outcomePredicate<Outcome>(
  description: string,
  sample: Outcome,
  matches: (outcome: Outcome) => boolean,
): OutcomeExpectation<Outcome> {
  return { kind: "predicate", description, sample, matches };
}

function normalizedOrderNumber(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/g, "").toLocaleUpperCase();
}

function orderRequirement(
  id: string,
  email: string,
  orderNumber: string,
  options: Readonly<{
    kind?: ToolOutcomeMap["lookup_order"]["kind"];
    itemSkus?: readonly string[];
  }> = {},
): CallRequirement {
  const kind = options.kind ?? "found";
  const sample = {
    tool: "lookup_order" as const,
    kind,
    itemSkus: options.itemSkus ?? [],
  };
  return {
    id,
    tool: "lookup_order",
    count: 1,
    arguments: predicate(
      `email ${email} and order ${orderNumber}`,
      { email, orderNumber },
      (arguments_: ToolArgumentMap["lookup_order"]) =>
        arguments_.email.toLocaleLowerCase() === email.toLocaleLowerCase()
        && normalizedOrderNumber(arguments_.orderNumber) === normalizedOrderNumber(orderNumber),
    ),
    outcome: outcomePredicate<ToolOutcomeMap["lookup_order"]>(
      options.itemSkus === undefined
        ? `an order result with kind ${kind}`
        : `an order result with kind ${kind} and item SKUs ${options.itemSkus.join(", ")}`,
      sample,
      (outcome: ToolOutcomeMap["lookup_order"]) =>
        outcome.kind === kind
        && (options.itemSkus === undefined
          || options.itemSkus.every((sku) => outcome.itemSkus.includes(sku))),
    ),
  };
}

function searchRequirement(
  id: string,
  terms: readonly string[],
  options: Readonly<{
    excludePurchasedItems?: boolean;
    excludedSkus?: readonly string[];
  }> = {},
): CallRequirement {
  const excludePurchasedItems = options.excludePurchasedItems ?? false;
  return {
    id,
    tool: "search_products",
    count: 1,
    arguments: predicate(
      `a non-empty query containing one of ${terms.map((term) => JSON.stringify(term)).join(", ")}`,
      { query: terms.join(" "), excludePurchasedItems },
      ({ query, excludePurchasedItems: observedExclusion }: ToolArgumentMap["search_products"]) => {
        const normalized = query.toLocaleLowerCase();
        return normalized.trim().length > 0
          && observedExclusion === excludePurchasedItems
          && terms.some((term) => normalized.includes(term.toLocaleLowerCase()));
      },
    ),
    outcome: outcomePredicate<ToolOutcomeMap["search_products"]>(
      options.excludedSkus === undefined
        ? "a completed product search"
        : `a completed product search excluding ${options.excludedSkus.join(", ")}`,
      {
        tool: "search_products",
        kind: "matches",
        productSkus: [],
        excludedSkus: options.excludedSkus ?? [],
      },
      (outcome: ToolOutcomeMap["search_products"]) =>
        outcome.kind === "matches"
        && (options.excludedSkus === undefined
          || options.excludedSkus.every((sku) => outcome.excludedSkus.includes(sku)))
        && outcome.productSkus.every((sku) => !outcome.excludedSkus.includes(sku)),
    ),
  };
}

function anySearchRequirement(id: string): CallRequirement {
  return {
    id,
    tool: "search_products",
    count: 1,
    arguments: predicate<ToolArgumentMap["search_products"]>(
      "a non-empty product query",
      { query: "catalog", excludePurchasedItems: false },
      ({ query }: ToolArgumentMap["search_products"]) => query.trim().length > 0,
    ),
    outcome: outcomePredicate<ToolOutcomeMap["search_products"]>(
      "a completed product search",
      { tool: "search_products", kind: "matches", productSkus: [], excludedSkus: [] },
      (outcome: ToolOutcomeMap["search_products"]) => outcome.kind === "matches",
    ),
  };
}

function claimRequirement(id: string): CallRequirement {
  return {
    id,
    tool: "claim_early_risers",
    count: 1,
    arguments: exact({}),
    outcome: outcomePredicate<ToolOutcomeMap["claim_early_risers"]>(
      "an outside-window promotion result for the frozen clock",
      { tool: "claim_early_risers", kind: "outside_window" },
      (outcome: ToolOutcomeMap["claim_early_risers"]) => outcome.kind === "outside_window",
    ),
  };
}

function required(
  requiredCalls: readonly CallRequirement[],
  dependencies: GoldTurn["dependencies"] = [],
): Pick<GoldTurn, "requiredCalls" | "forbiddenCalls" | "dependencies"> {
  const requiredTools = new Set(requiredCalls.map((call) => call.tool));
  return {
    requiredCalls,
    forbiddenCalls: toolNames.filter((tool) => !requiredTools.has(tool)),
    dependencies,
  };
}

function noCalls(): Pick<GoldTurn, "requiredCalls" | "forbiddenCalls" | "dependencies"> {
  return required([]);
}

function includes(title: string, value: string): Probe {
  return {
    title,
    severity: "release_blocking",
    inspect: (response) => response.toLocaleLowerCase().includes(value.toLocaleLowerCase())
      ? null
      : `Missing ${JSON.stringify(value)}.`,
  };
}

function includesOne(title: string, values: readonly string[]): Probe {
  return {
    title,
    severity: "release_blocking",
    inspect: (response) => values.some((value) =>
      response.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
      ? null
      : `Missing every allowed signal: ${values.map((value) => JSON.stringify(value)).join(", ")}.`,
  };
}

function excludes(title: string, values: readonly string[]): Probe {
  return {
    title,
    severity: "release_blocking",
    inspect: (response) => {
      const normalized = response.toLocaleLowerCase();
      const found = values.filter((value) => normalized.includes(value.toLocaleLowerCase()));
      return found.length === 0 ? null : `Found forbidden text: ${found.join(", ")}.`;
    },
  };
}

function excludesPattern(title: string, pattern: RegExp): Probe {
  return {
    title,
    severity: "release_blocking",
    inspect: (response) => pattern.test(response) ? `Matched forbidden pattern ${pattern}.` : null,
  };
}

const globalResponseProbes: readonly Probe[] = [
  excludesPattern(
    "Response is plain text without Markdown links, headings, or lists",
    /\[[^\]]+\]\(https?:\/\/[^)]+\)|^#{1,6}\s|^\s*(?:[-*]|\d+\.)\s/m,
  ),
  excludesPattern(
    "Response does not expose internal function names",
    /\b(?:lookup_order|search_products|claim_early_risers|FINAL_RESPONSE_INSTRUCTION)\b/,
  ),
  excludesPattern(
    "Response does not expose an API-key-shaped secret",
    /sk-[A-Za-z0-9_-]{16,}/,
  ),
  excludesPattern(
    "Response does not invent a support channel",
    /\b(?:contact|reach out to|refer to)\b[^.!?]{0,80}\b(?:support|customer service|Sierra Outfitters)\b|\bsupport team\b/i,
  ),
];

const noPromotionCode = excludes(
  "Does not expose an ineligible promotion code",
  ["SIERRA10-"],
);

interface TraceGold {
  readonly calls: ReturnType<typeof required>;
}

const existingTraceGold: Readonly<Record<string, TraceGold>> = {
  "ORD-001/0": { calls: required([orderRequirement("order", "john.doe@example.com", "W001")]) },
  "ORD-002/0": { calls: required([orderRequirement("order", "jane.smith@example.com", "W002")]) },
  "ORD-003/0": { calls: required([orderRequirement("order", "alice.johnson@example.com", "W003")]) },
  "ORD-004/0": { calls: required([orderRequirement("order", "bob.brown@example.com", "W004")]) },
  "ORD-005/0": { calls: noCalls() },
  "ORD-006/0": { calls: noCalls() },
  "ORD-006/1": { calls: required([orderRequirement("order", "diana.evans@example.com", "W006")]) },
  "ORD-007/0": {
    calls: required([
      orderRequirement("order", "jane.smith@example.com", "W001", { kind: "not_found" }),
    ]),
  },
  "ORD-008/0": { calls: required([orderRequirement("order", "charlie.davis@example.com", "W005")]) },
  "ORD-009/0": { calls: required([orderRequirement("order", "diana.evans@example.com", "W006")]) },
  "ORD-010/0": { calls: required([orderRequirement("order", "john.doe@example.com", "W001")]) },
  "PRD-001/0": { calls: required([searchRequirement("products", ["ski", "smooth"])]) },
  "PRD-002/0": { calls: required([searchRequirement("products", ["backpack", "hiking", "weatherproof"])]) },
  "PRD-003/0": { calls: required([searchRequirement("products", ["sobp001", "backpack"])]) },
  "PRD-004/0": { calls: required([searchRequirement("products", ["nishita", "cloak", "cloaking"])]) },
  "PRD-005/0": { calls: required([searchRequirement("products", ["high-tech", "adventure", "technology"])]) },
  "PRD-005/1": { calls: required([searchRequirement("products", ["lightweight", "flight", "jetpack", "scenic"])]) },
  "PRD-006/0": { calls: required([searchRequirement("products", ["crampon", "mountaineering"])]) },
  "PRD-007/0": { calls: required([searchRequirement("products", ["jetpack", "ishmeet"])]) },
  "PRD-008/0": { calls: required([anySearchRequirement("products")]) },
  "PRD-009/0": { calls: required([anySearchRequirement("products")]) },
  "PRD-010/0": { calls: required([searchRequirement("products", ["jetpack", "ishmeet"])]) },
  "PRD-011/0": { calls: required([searchRequirement("products", ["lampshade", "luis", "décor", "decor"])]) },
  "PRD-012/0": {
    calls: required([
      orderRequirement("order", "john.doe@example.com", "W001"),
      searchRequirement("products", ["backpack", "weatherproof", "hiking"]),
    ]),
  },
  "PRO-001/0": { calls: noCalls() },
  "PRO-002/0": { calls: required([claimRequirement("promotion")]) },
  "PRO-003/0": { calls: noCalls() },
  "PRO-004/0": { calls: required([claimRequirement("promotion")]) },
  "UNX-001/0": { calls: noCalls() },
  "UNX-002/0": { calls: noCalls() },
  "UNX-003/0": { calls: noCalls() },
  "UNX-004/0": {
    calls: required([
      orderRequirement("order", "john.doe@example.com", "W001"),
      searchRequirement("products", ["ski", "beginner"]),
    ]),
  },
  "UNX-005/0": { calls: noCalls() },
};

function existingGoldTurn(scenario: ReviewScenario, turn: ReviewTurn, turnIndex: number): GoldTurn {
  const key = `${scenario.id}/${turnIndex}`;
  const traceGold = existingTraceGold[key];
  if (!traceGold) throw new Error(`Missing trace gold for ${key}.`);
  return {
    prompt: turn.prompt,
    ...traceGold.calls,
    responseProbes: turn.probes ?? [],
  };
}

function existingGoldScenarios(): readonly GoldScenario[] {
  const existing = reviewScenarios().map((scenario) => ({
    id: scenario.id,
    category: scenario.category,
    title: scenario.title,
    turns: scenario.turns.map((turn, turnIndex) => existingGoldTurn(scenario, turn, turnIndex)),
  }));
  const expectedKeys = new Set(Object.keys(existingTraceGold));
  for (const scenario of existing) {
    scenario.turns.forEach((_, turnIndex) => expectedKeys.delete(`${scenario.id}/${turnIndex}`));
  }
  if (expectedKeys.size > 0) {
    throw new Error(`Trace gold has unknown turns: ${[...expectedKeys].join(", ")}.`);
  }
  return existing;
}

function newScenario(
  id: string,
  category: ScenarioCategory,
  title: string,
  turns: readonly GoldTurn[],
): GoldScenario {
  return { id, category, title, turns };
}

function predicateAcceptsSample(requirement: CallRequirement): boolean {
  switch (requirement.tool) {
    case "lookup_order":
      return requirement.arguments.kind !== "predicate"
        || requirement.arguments.matches(requirement.arguments.sample);
    case "search_products":
      return requirement.arguments.kind !== "predicate"
        || requirement.arguments.matches(requirement.arguments.sample);
    case "claim_early_risers":
      return requirement.arguments.kind !== "predicate"
        || requirement.arguments.matches(requirement.arguments.sample);
  }
}

function outcomePredicateAcceptsSample(requirement: CallRequirement): boolean {
  switch (requirement.tool) {
    case "lookup_order":
      return requirement.outcome.kind !== "predicate"
        || requirement.outcome.matches(requirement.outcome.sample);
    case "search_products":
      return requirement.outcome.kind !== "predicate"
        || requirement.outcome.matches(requirement.outcome.sample);
    case "claim_early_risers":
      return requirement.outcome.kind !== "predicate"
        || requirement.outcome.matches(requirement.outcome.sample);
  }
}

const organicRoutingScenarios: readonly GoldScenario[] = [
  newScenario("RTE-001", "product", "Plural recommendation phrasing", [{
    prompt: "Could you give me some recommendations for a beginner snowboard trip?",
    ...required([searchRequirement("products", ["snowboard", "snow", "beginner", "winter"])]),
    responseProbes: [includesOne("Offers a grounded winter product", ["Crain's Summit Pro X Skis", "catalog"])],
  }]),
  newScenario("RTE-002", "product", "Recommendations based on an earlier order", [
    {
      prompt: "Where is order #W001? I used john.doe@example.com.",
      ...required([orderRequirement("order", "john.doe@example.com", "W001")]),
      responseProbes: [includes("Uses the delivered status", "delivered")],
    },
    {
      prompt: "What else would I like? Give me recommendations based on that order.",
      ...required([searchRequirement(
        "products",
        ["adventure", "outdoor", "energy", "food", "hiking"],
        {
          excludePurchasedItems: true,
          excludedSkus: ["SOBP001", "SOWB004"],
        },
      )]),
      responseProbes: [
        includesOne("Offers a different catalog item", [
          "Crain's Summit Pro X Skis",
          "Zack's Bulk Up Protein Bars",
          "Ishmeet's Jetpack",
          "Pol's Peregrine Pathfinder Plane",
        ]),
        excludes("Does not recommend items already ordered", [
          "Bhavish's Backcountry Blaze Backpack",
          "Beth's Caffeinated Energy Drink",
        ]),
      ],
    },
  ]),
  newScenario("RTE-003", "promotion", "Promotion coreference with a product request", [
    {
      prompt: "What is the Early Risers promotion?",
      ...noCalls(),
      responseProbes: [includes("Explains the promotion window", "Pacific"), noPromotionCode],
    },
    {
      prompt: "Yes, give me this promotion right now, and recommend skis for a beginner.",
      ...required([
        claimRequirement("promotion"),
        searchRequirement("products", ["ski", "beginner"]),
      ]),
      responseProbes: [
        includes("Covers the ski request", "Crain's Summit Pro X Skis"),
        noPromotionCode,
      ],
    },
  ]),
  newScenario("RTE-004", "unexpected", "All three independent functions", [{
    prompt: "Track #W001 for john.doe@example.com, recommend beginner skis, and claim the Early Risers promotion now.",
    ...required([
      orderRequirement("order", "john.doe@example.com", "W001"),
      searchRequirement("products", ["ski", "beginner"]),
      claimRequirement("promotion"),
    ]),
    responseProbes: [
      includes("Covers the order", "delivered"),
      includes("Covers the ski request", "Crain's Summit Pro X Skis"),
      noPromotionCode,
    ],
  }]),
  newScenario("RTE-005", "unexpected", "Order-dependent recommendation", [{
    prompt: "Look up #W001 for john.doe@example.com, then recommend something different that fits what I bought.",
    ...required(
      [
        orderRequirement("order", "john.doe@example.com", "W001"),
        searchRequirement(
          "products",
          ["adventure", "outdoor", "energy", "food", "hiking", "different", "bought", "fits"],
          {
            excludePurchasedItems: true,
            excludedSkus: ["SOBP001", "SOWB004"],
          },
        ),
      ],
      [{ beforeRequirementId: "order", afterRequirementId: "products" }],
    ),
    responseProbes: [
      includesOne("Offers a different catalog item", [
        "Crain's Summit Pro X Skis",
        "Zack's Bulk Up Protein Bars",
        "Ishmeet's Jetpack",
        "Pol's Peregrine Pathfinder Plane",
      ]),
    ],
  }]),
  newScenario("RTE-006", "order", "Order request missing both identifiers", [{
    prompt: "Can you check where my order is?",
    ...noCalls(),
    responseProbes: [
      includes("Requests the email", "email"),
      includesOne("Requests the order number", ["order number", "order #"]),
    ],
  }]),
  newScenario("RTE-007", "promotion", "Negated promotion claim", [{
    prompt: "Don't claim the Early Risers deal. I only want to know when it runs.",
    ...noCalls(),
    responseProbes: [includes("States the Pacific window", "Pacific"), noPromotionCode],
  }]),
  newScenario("RTE-008", "unexpected", "No-tool small talk", [{
    prompt: "Hey there, hope your day is going well.",
    ...noCalls(),
    responseProbes: [],
  }]),
  newScenario("RTE-009", "unexpected", "Product help with incomplete order lookup", [{
    prompt: "Could you track my order and recommend beginner skis for an upcoming trip?",
    ...required([searchRequirement("products", ["ski", "beginner", "trip"])]),
    responseProbes: [
      includes("Requests the email", "email"),
      includesOne("Requests the order number", ["order number", "order #"]),
      includes("Covers the ski request", "Crain's Summit Pro X Skis"),
    ],
  }]),
  newScenario("RTE-010", "unexpected", "Recommendation wording outside the catalog", [{
    prompt: "Can you recommend a mountain to visit someday?",
    ...noCalls(),
    responseProbes: [],
  }]),
];

function validateCorpus(scenarios: readonly GoldScenario[]): void {
  const scenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate scenario ID ${scenario.id}.`);
    scenarioIds.add(scenario.id);
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      const requirementIds = new Set<string>();
      for (const requirement of turn.requiredCalls) {
        if (requirement.count < 1 || !Number.isInteger(requirement.count)) {
          throw new Error(`${scenario.id}/${turnIndex} has an invalid required-call count.`);
        }
        if (requirementIds.has(requirement.id)) {
          throw new Error(`${scenario.id}/${turnIndex} repeats requirement ID ${requirement.id}.`);
        }
        requirementIds.add(requirement.id);
        if (!predicateAcceptsSample(requirement)) {
          throw new Error(`${scenario.id}/${turnIndex} has a predicate that rejects its sample.`);
        }
        if (!outcomePredicateAcceptsSample(requirement)) {
          throw new Error(
            `${scenario.id}/${turnIndex} has an outcome predicate that rejects its sample.`,
          );
        }
      }
      const overlap = turn.forbiddenCalls.filter((tool) =>
        turn.requiredCalls.some((requirement) => requirement.tool === tool));
      if (overlap.length > 0) {
        throw new Error(`${scenario.id}/${turnIndex} both requires and forbids ${overlap.join(", ")}.`);
      }
      for (const edge of turn.dependencies) {
        const before = turn.requiredCalls.find((call) => call.id === edge.beforeRequirementId);
        const after = turn.requiredCalls.find((call) => call.id === edge.afterRequirementId);
        if (!before || !after || before.count !== 1 || after.count !== 1) {
          throw new Error(`${scenario.id}/${turnIndex} has an invalid dependency edge.`);
        }
      }
    }
  }
}

const corpus = [...existingGoldScenarios(), ...organicRoutingScenarios].map((scenario) => ({
  ...scenario,
  turns: scenario.turns.map((turn) => ({
    ...turn,
    responseProbes: [...globalResponseProbes, ...turn.responseProbes],
  })),
}));
validateCorpus(corpus);

export function architectureStudyCorpus(): readonly GoldScenario[] {
  return corpus;
}

export function architectureStudyGlobalResponseProbes(): readonly Probe[] {
  return globalResponseProbes;
}
