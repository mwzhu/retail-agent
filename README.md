# Sierra Outfitters trail guide

This project is a small customer-service agent for Sierra Outfitters. It streams responses in a web chat, persists completed conversations in SQLite, retrieves a bounded product set through FTS5, and uses direct OpenAI function calls for three customer tasks.

## Run the first draft

Install the dependencies.

```bash
npm install
```

Run the deterministic demo when you want to test the full browser flow without an API key.

```bash
npm run demo
```

Open `http://127.0.0.1:5173`.

To use OpenAI, create `.env` from `.env.example`. Put the provided assessment key in `OPENAI_API_KEY`, then run the development servers.

```bash
cp .env.example .env
npm run dev
```

The server uses `gpt-4o` by default. Set `OPENAI_MODEL` only when your key has access to another allowed model.

## Try the supported tasks

Use these prompts to exercise the agent:

- `Can you recommend gear for a skiing trip?`
- `I want to claim the Early Risers promotion.`
- `Track order #W001 for john.doe@example.com.`

The promotion only issues a code from 8:00 AM inclusive to 10:00 AM exclusive in `America/Los_Angeles`. A conversation receives one code per Pacific calendar date. The app has no authenticated customer identity, so the limit applies to the conversation rather than a person.

## Check the project

Run the deterministic tests and production build.

```bash
npm run verify
```

Build the browser files and serve the complete application from Fastify.

```bash
npm run build
npm start
```

Open `http://127.0.0.1:3001`.

## How one turn works

The browser sends one `POST /api/chat` request and reads newline-delimited JSON from the response body. The server persists the user message before generation. The agent may run two non-streaming tool-planning rounds. It then makes one tool-disabled streaming call and forwards text deltas to the browser. The server persists the assistant message only after the final response completes.

If the connection or process stops during generation, the conversation keeps a pending user message. Reload the page and use **Retry**. P0 does not resume the interrupted token stream.

The model never receives the complete product catalog. SQLite FTS5 retrieves no more than five products across the full turn. Exact SKU lookup bypasses text search. Product results contain only catalog facts.

## Persistence and data

SQLite stores conversations, messages, promotion grants, products, and orders. The app reseeds the static catalog and order tables in one transaction at startup. It preserves conversations and promotion grants.

The order fixture references three SKUs that are absent from the product catalog:

- `SOBN008`
- `SOCH010`
- `SOGK009`

Order lookup preserves those SKUs and reports an unavailable catalog name. It does not invent one.

## Security boundaries

The API key stays on the server. The repository ignores `.env`, SQLite files, build output, and local coverage files. Do not put the provided key in source, screenshots, logs, or browser code.

Order lookup requires both the normalized email and the normalized order number. A failed pair returns one generic result. The app generates a USPS URL only when the order row has a tracking number.

## Deliberate P0 limits

This first draft targets a four-to-six-hour implementation. It omits authentication, multi-process coordination, partial-draft persistence, stream replay, automatic retries, cancellation, Markdown rendering, and a conversation sidebar. [DESIGN.md](DESIGN.md) explains why those cuts keep the code useful for the onsite extension.
