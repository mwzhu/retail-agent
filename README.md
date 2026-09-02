# Sierra Outfitters trail guide

This project is a customer-service agent for Sierra Outfitters. It supports product recommendations, order lookup, and the Early Risers promotion in a streaming React chat. SQLite persists conversations and business data, and SQLite FTS5 keeps product retrieval bounded.

The production path uses two OpenAI calls per turn. The first call returns a typed three-slot intent plan. The server executes trusted capabilities, then the second call streams an answer grounded in their results. Independent capabilities run concurrently. A product search that depends on an order waits for the verified order result.

## Run the application

Install the dependencies.

```bash
npm install
```

Create `.env` from `.env.example`. Set `OPENAI_API_KEY`, then start the API and web development servers.

```bash
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`.

The server uses `gpt-4o` by default. Set `OPENAI_MODEL` only when your key has access to another allowed model.

## Try the supported tasks

Use these prompts to exercise each capability:

- `Can you recommend gear for a skiing trip?`
- `Track order #W001 for john.doe@example.com.`
- `I want to claim the Early Risers promotion.`

The agent also supports multi-intent and multi-turn requests:

```text
Check order W002 for jane.smith@example.com, recommend something based on that order, and give me the Early Risers code.
```

For that request, order lookup and promotion claim run together. Product retrieval waits for the order result, derives search terms from the purchased products, and excludes their SKUs.

The promotion issues a code only from 8:00 AM inclusive to 10:00 AM exclusive in `America/Los_Angeles`. A conversation receives one code per Pacific calendar date. The app has no authenticated customer identity, so the limit applies to a conversation rather than a person.

## Check the project

Run the deterministic tests and production build.

```bash
npm run verify
```

With an OpenAI-backed server running on port 3001, run the adversarial agent review.

```bash
npm run review:agent -- --output=.audit/agent-review/my-run
```

The review runs 31 isolated scenarios and 33 model turns. It checks the three capabilities, multi-turn behavior, stream ordering, exact transcript persistence, fixture facts, privacy rules, input validation, secret leakage, prompt injection, and brand voice. The command writes `results.json` and a prompt-and-response catalog to the output directory.

Run the controlled architecture comparison with an OpenAI key available.

```bash
npm run compare:agent -- --repetitions=3 --run-id=my-comparison
```

The comparison evaluates `auto`, regex-guided `sequence`, and structured `plan` against both capability-description versions. It records required-call recall, precision, exact traces, argument and outcome accuracy, dependency accuracy, multi-intent completion, response assertions, model calls, and latency. Each cell uses a fresh server and SQLite database. The runner freezes and hashes its source inputs so the implementation cannot change during a study.

Build the browser files and serve the complete application from Fastify.

```bash
npm run build
npm start
```

Open `http://127.0.0.1:3001`.

## How one turn works

1. The browser sends one `POST /api/chat` request and reads newline-delimited JSON events from the response body.
2. The server persists the user message and marks the reply as pending.
3. One non-streaming OpenAI call returns a strict intent plan with `order`, `product`, and `promotion` slots.
4. The server validates the plan. It runs independent capabilities concurrently and preserves order-to-product dependencies.
5. One tool-disabled OpenAI call receives the current request, verified context, and current capability results. The server streams its text deltas to the browser.
6. The server persists the complete assistant message and clears the pending marker.

If the connection or process stops during generation, the conversation keeps the pending user message. Reload the page and use **Retry**. This P0 does not resume an interrupted token stream.

Planning receives recent conversation history and verified order context. Final synthesis excludes earlier assistant prose. This prevents an old refusal or unsupported claim from leaking into a later answer.

## Retrieval and trusted state

The model never receives the complete product catalog. An exact SKU lookup runs first. Otherwise, SQLite FTS5 performs lexical retrieval with Porter stemming and BM25 ranking. The server returns at most five compact product records across a turn.

Order-derived recommendations use tags from the verified purchased products and exclude their SKUs. Product inventory reaches the final model only when the current request explicitly asks for a count.

SQLite stores conversations, messages, pending replies, verified order context, promotion grants, products, and orders. The app reseeds static products and orders in one startup transaction. It preserves conversations and promotion grants.

The order fixture references three SKUs that are absent from the product catalog:

- `SOBN008`
- `SOCH010`
- `SOGK009`

Order lookup preserves those SKUs and reports an unavailable catalog name. It does not invent one.

## Brand voice

The agent uses a light Sierra outdoor voice on successful and neutral replies. Eligible replies usually end with one short outdoor flourish and one varied emoji. Clarification-only responses, refusals, unsuccessful lookups, and other bad news contain neither.

The adversarial review measures eligible brand-language and emoji coverage. Human or model review still judges whether the wording fits the response.

## Security boundaries

The API key stays on the server. The repository ignores `.env`, SQLite files, build output, coverage, and local audit runs. Do not put the key in source, screenshots, logs, or browser code.

Order lookup requires both the normalized email and normalized order number. A failed pair returns one generic result. The app generates a USPS URL only when the order row has a tracking number.

## P0 limits

This project does not include authentication, account-level authorization, multi-process coordination, partial-draft persistence, stream replay, automatic model retries, cancellation, rate limits, or production telemetry. [DESIGN.md](DESIGN.md) explains these choices and the path to a production version.
