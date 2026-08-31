# About the Sierra Outfitters P0 design

The application uses one TypeScript package with four ownership areas. `src/client` owns browser state and streamed response parsing. `src/server/routes.ts` owns HTTP and NDJSON serialization. `src/server/agent` owns the direct model loop and tool registry. `src/server/data` owns SQLite, FTS5, and business transactions.

The route calls one `ChatApplication.openTurn` operation. That operation persists or reloads the pending user message, runs model and tool work, streams final text, and commits the assistant message. Fastify does not coordinate those stages itself. This boundary keeps the normal request path short enough to explain during the onsite.

## Why the final call streams

Tool-selection calls do not stream. This avoids reconstructing fragmented function-call arguments from streamed protocol chunks. The agent makes at most three planning rounds, one per supported capability. It then makes one final call without tools and streams the response.

This costs an additional call for a message that needs no tools. It buys a smaller state model and a clear guarantee that a streamed final answer cannot turn into another tool call.

## Why persistence stops at complete messages

The app persists a user message before model work and an assistant message after successful completion. It does not persist partial assistant drafts or tool envelopes.

A failed turn therefore has one durable shape. The conversation ends in a user message. The browser derives the Retry action from that shape. Exact stream resumption would require durable event sequences, draft watermarks, replay ordering, and more client state. Those guarantees do not fit this P0.

## Why product retrieval uses FTS5

The current catalog has ten products, but sending all ten on every request creates the wrong boundary. FTS5 gives the agent a stable search interface and keeps model input bounded as the catalog grows.

Search performs an exact SKU lookup first. Otherwise it builds a safe whole-token FTS query, uses Porter stemming, orders SQLite BM25 scores in ascending order, and returns at most five compact product records. The design does not claim semantic, multilingual, or autocomplete search.

## Why promotion identity is conversation scoped

The brief does not define an authenticated customer identity. The database therefore applies `UNIQUE(conversation_id, pacific_date)`. A retry returns the same code. A new conversation can receive another code.

A production implementation would key grants to an authenticated account and a defined promotion campaign. Hashing an unverified email would look stronger without providing real identity.

## Extension path

A new customer capability adds one tool schema, one validated handler, one store operation when data is required, and focused tests. The HTTP stream, persistence rule, and browser reducer do not change.

Production scale would change infrastructure behind the same boundaries. PostgreSQL would replace SQLite. A durable worker would replace the in-process turn guard. Cross-process event delivery would replace the direct response stream. A hosted lexical or hybrid search service would replace FTS5 when catalog size or language requirements justify it.
