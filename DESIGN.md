# About the Sierra Outfitters agent design

The application separates probabilistic language work from deterministic business work. One OpenAI call interprets the request as a typed plan. Server code validates and executes that plan against trusted data. A second OpenAI call writes the final response from the current request and verified results.

This structure keeps the LLM responsible for language and leaves order truth, product truth, promotion eligibility, side effects, and persistence in code.

## Component ownership

The project uses one TypeScript package with four ownership areas:

- `src/client` owns browser state and NDJSON stream parsing.
- `src/server/routes.ts` owns HTTP validation and stream serialization.
- `src/server/agent` owns planning, capability execution, grounding, and final synthesis.
- `src/server/data` owns SQLite, FTS5 retrieval, and business transactions.

The route calls one `ChatApplication.openTurn` operation. That operation persists or reloads a pending user message, runs the agent, streams final text, and commits the assistant message. Fastify does not coordinate the internal stages.

## Why the agent uses a structured plan

The production configuration uses `plan` with the `guided` capability specification. The planner returns one value for each fixed slot:

- `order` is `none` or `lookup` with an email and order number.
- `product` is `none` or `search` with a query, an exclusion flag, and `independent` or `after_order` timing.
- `promotion` is `none` or `claim`.

Boundary validation rejects unknown fields, missing arguments, and invalid dependencies. The fixed shape fits this domain because it has three capabilities and one meaningful dependency. A general workflow graph would add more states without solving a current requirement.

The server converts the plan into execution batches. Order, independent product search, and promotion claim can run together. An `after_order` product search runs in the next batch. This makes multi-intent behavior explicit and testable.

The repository retains `auto` and regex-guided `sequence` modes for controlled comparisons. They are not the production defaults. Small deterministic intent checks still protect known failures around food requests, inventory disclosure, and explicit promotion claims.

## Why this architecture replaced automatic tool selection

The architecture study varied planning strategy and capability descriptions as separate factors. It compared six cells across `auto`, `sequence`, and `plan`, with the original and guided descriptions.

The release gate ran three frozen repetitions of the full corpus:

- 41 scenarios and 45 turns per cell per repetition
- 6 cells and 810 real streamed turns
- a fresh server, port, SQLite database, and conversation set for each cell
- a fixed clock, model, temperature, prompt, corpus, and product budget

On that corpus, `plan/guided` reached 100% required-call recall, precision, exact-trace accuracy, argument accuracy, outcome accuracy, dependency accuracy, multi-intent completion, and response assertions in every repetition. It used 2.00 model calls per turn. The controlled `auto/current` cell used 2.67 calls per turn and reached 82.5% required-call recall, 80.7% exact traces, and 80% multi-intent completion.

The median latency for `plan/guided` was 1,685 ms, and p95 was 2,237 ms. The controlled `auto/current` cell measured 2,214 ms at the median and 4,095 ms at p95. The latency gain came from replacing repeated model-planning rounds with one plan call. SQLite capability execution took about one millisecond, so local parallel calls contributed little to the measured gain.

These numbers support the architecture on the frozen corpus. They are not production confidence intervals. Later fixes for W002 follow-ups, food requests, and inventory disclosure have focused regression and browser coverage. The full six-cell study has not been rerun after all of those fixes.

## Why the final call streams

Planning does not stream. The server receives and validates one complete structured plan instead of reconstructing partial function arguments from protocol chunks.

The final call has no tools. It receives the current request, fixed promotion facts, verified order context, and current capability results. Earlier assistant prose is excluded from final synthesis. This prevents an old refusal or unsupported statement from affecting the current answer.

The final call streams text because users benefit from early feedback while the answer is generated. Fastify sends typed NDJSON events over one HTTP response. The client handles accepted, delta, completed, and failed events without a WebSocket connection.

This design always spends one final model call, even when the request needs no capability. The extra call keeps streamed output free of tool-call states and gives the server one place to enforce final grounding and brand rules.

## Why deterministic code checks sensitive behavior

The planner decides which capabilities a request needs, but code still authorizes side effects and controls sensitive data.

- The promotion executor verifies an explicit current request before it checks the Pacific-time window or issues a code.
- The store computes promotion eligibility and generates the code. The model cannot supply the clock or code.
- The server forces product retrieval for food, drink, hunger, and thirst requests if the planner omits it.
- The executor removes inventory from model-facing product results unless the current request explicitly asks for a count.

These checks fix observed high-cost failures at the boundary. Phrase matching can become hard to maintain as capabilities grow. A larger version should consolidate these rules into a typed policy layer and add a defined retry or repair path for rejected plans.

## Why persistence stops at complete messages

The app persists the user message before model work and marks its reply as pending. It persists the assistant message only after the final stream completes. It does not persist partial assistant drafts or model protocol envelopes.

A failed turn therefore has one durable shape. The conversation ends with a pending user message, and the browser offers a retry. Exact stream resumption would require durable event IDs, draft watermarks, replay ordering, and more client state. Those guarantees do not fit this P0.

The process also keeps an in-memory lock per active conversation. SQLite preserves state across restarts, but the lock does not coordinate multiple server processes.

## Why product retrieval uses FTS5

The catalog is small, but sending the full catalog on every turn would create the wrong boundary. The server performs exact SKU lookup first. Otherwise, FTS5 builds a safe whole-token query, uses Porter stemming, ranks with BM25, and returns at most five compact records across the turn.

FTS5 is local, bounded, cheap, and inspectable. It does not provide semantic similarity, fuzzy matching, multilingual retrieval, or learned personalization. A larger catalog can keep the same `search_products` capability while replacing FTS5 with hosted lexical or hybrid retrieval.

## How order-derived recommendations work

A successful order lookup stores verified order context for the conversation. The context includes status, tracking, item names, item SKUs, and recommendation terms derived from the purchased products' catalog tags.

For a request such as "what else would I like," the planner sets `excludePurchasedItems` and schedules product search after the order lookup when required. The executor uses the verified recommendation terms and excludes the purchased SKUs. A replacement request or an unrelated product request does not apply those exclusions.

This is content-based retrieval, not collaborative personalization. It uses product metadata from one verified order and does not learn from behavior across customers.

## Why promotion grants use conversation identity

The brief does not define an authenticated customer identity. The database therefore applies one promotion grant per conversation and Pacific date. A retry returns the same code. A new conversation can receive another code.

A production implementation should key grants to an authenticated account and promotion campaign. Hashing an unverified email would not create a trustworthy identity.

## Brand voice and grounding

The shared prompt asks for a short outdoor flourish and one varied emoji on most eligible successful or neutral replies. Clarification-only responses, refusals, unsuccessful lookups, and other bad news must omit both.

The final model can state retail facts only from fixed promotion facts, verified order context, and current capability results. Product inventory is a stronger boundary: the model does not receive the count unless the current user asks for it.

Automated probes measure brand-language coverage, emoji coverage, factual assertions, unsupported claims, and privacy rules. Human or blinded model review still judges whether generated language is natural and appropriate.

## Production path

A production version can preserve the capability and application boundaries while changing the infrastructure:

- PostgreSQL replaces SQLite.
- A durable lease or worker replaces the in-process conversation lock.
- A durable event stream replaces direct response streaming when replay becomes a requirement.
- Authenticated account ownership protects conversation and order data.
- Campaign-scoped promotion grants replace conversation-scoped grants.
- Hybrid retrieval and reranking replace FTS5 when relevance data justifies the cost.
- Tracing, token and cost metrics, rate limits, cancellation, retention rules, and prompt-injection monitoring become required operational controls.
