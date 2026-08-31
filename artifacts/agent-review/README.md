# Agent adversarial review

The final OpenAI-backed run completed 31 isolated scenarios and 33 model turns. All 357 automatic turn checks and all four HTTP boundary checks passed. A manual review passed all 29 release-blocking language judgments and all four advisory judgments.

The automatic checks cover NDJSON event order, streamed-text concatenation, transcript persistence, pending-message cleanup, exact fixture facts, privacy tripwires, plain-text output, internal-name leakage, secret-shaped output, and unsupported support channels. The manual judgments cover conversation quality, intent completion, semantic grounding, and refusal behavior.

## Coverage

| Area | Scenarios | Turns | Representative cases |
|---|---:|---:|---|
| Order lookup | 10 | 11 | Tracked, untracked, unreliable status, missing identifiers, cross-turn identifiers, mismatch privacy, normalization, injection, unsupported mutation |
| Product retrieval | 12 | 13 | Recommendations, exact SKU, inventory, refinement, no match, missing price and policy, catalog extraction, hostile search text, injection, Unicode, mixed order request |
| Early Risers | 4 | 4 | Information only, explicit claim outside the window, negation, customer-supplied clock and code |
| Unexpected input | 5 | 5 | Small talk, secret extraction, unsupported refund, three supported intents in one turn, nonsense |

The deterministic suite adds 29 tests for all three function routes, the shared five-product budget, 08:00 and 10:00 Pacific boundaries, same-code recovery across the closing boundary, retry persistence, invalid HTTP input, conversation errors, and the NDJSON contract.

## Evidence

- [Prompt and response catalog](review/report.md) contains every user prompt, exact streamed agent response, automatic check, and pending language judgment.
- [Machine-readable results](review/results.json) contains the parsed event streams, response durations, checks, and conversation IDs.
- The language judgments remain `review_required` in generated evidence by design. The counts above record the separate manual adjudication; the runner never turns wording heuristics into automatic passes.

Claude Opus independently reviewed the near-final evidence and found four product-category release blockers: unsupported support referrals, lexical-noise recommendations, purchase-availability language, and a truncated catalog description that invited invented completion. The final implementation fixes those root causes, and the final evidence run passed the new regression checks.

The live promotion run occurred outside the 8:00 to 10:00 AM Pacific window, so it correctly contains no grant code. Fixed-time tests cover 07:59:59, 08:00:00, 09:59:59.999, 10:00:00, repeated grants, and retry after the window closes.

## Screenshots

### Tracked order

![Tracked order conversation](screenshots/order-tracking.jpg)

### Grounded product recommendation

![Grounded ski recommendation](screenshots/product-recommendation.jpg)

### Negated promotion request

![Promotion information without a claim](screenshots/promotion-negation.jpg)

### Prompt and secret extraction refusal

![Prompt and secret extraction refusal](screenshots/prompt-injection-refusal.jpg)
