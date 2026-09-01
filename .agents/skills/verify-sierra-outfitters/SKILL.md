---
name: verify-sierra-outfitters
description: Drive the OpenAI-backed Sierra Outfitters React chat and prove product recommendations, order tracking, Early Risers, and conversation persistence. Use after UI, streaming, agent, route, OpenAI, or SQLite changes.
---

# Verify Sierra Outfitters

Drive the built React application through the same Fastify and OpenAI path a customer uses. Give each run its own port and SQLite database. Keep the proof after cleanup.

Read [the feature map](./features/README.md) before choosing a recipe. The React chat is the primary user interface. Use the Fastify health route and SQLite database only to validate the instance and its durable effects.

## Launch

Run from the repository root. The application reads `OPENAI_API_KEY` from the inherited environment or the ignored root `.env`. Never pass the key to a helper, print it, or place it in evidence.

```bash
npm run build
verification_run_id="verify-$(date -u +%Y%m%dT%H%M%SZ)-$$"
verification_port=43101
./.agents/skills/verify-sierra-outfitters/scripts/launch.sh "$verification_run_id" "$verification_port"
```

If port 43101 is occupied, choose another unused port above 1024. `launch.sh` refuses an occupied port and a run ID with existing state or evidence. It overrides only `HOST`, `PORT`, and `DATABASE_PATH`. The application selects its normal OpenAI client.

`launch.sh` stays attached to the server. In Codex, run it with a short yield and keep the command session open. Run the doctor from a separate command. If the doctor reports that the server is not OpenAI-backed, clean up the run and stop. Do not fall back to another model path.

```bash
./.agents/skills/verify-sierra-outfitters/scripts/cleanup.sh "$verification_run_id"
```

## Doctor

Run the read-only doctor before opening the browser and whenever the page looks stale or offline.

```bash
./.agents/skills/verify-sierra-outfitters/scripts/doctor.sh "$verification_run_id"
```

The doctor requires all of these facts:

- The recorded PID is alive and its working directory is this repository.
- That PID owns the recorded listening port and runs `src/server/index.ts`.
- `GET /api/health` reports `openai` mode.
- The current `dist` digest matches the build launched for this run.
- The database and evidence paths stay inside this repository's verification directories.

The health route proves that the server selected the OpenAI client. A completed browser turn proves provider authentication and reachability. Do not drive a run whose doctor fails. Do not attach to a process merely because it answers the health route.

## Drive

Use the Codex in-app Browser skill and its `browser-client` runtime. Do not install Playwright or Cypress. Use ARIA labels, roles, visible facts, and route paths from this repository.

After Browser setup, bind the only active verification run. This block refuses ambiguity instead of guessing which instance to drive.

```js
const verificationFs = await import("node:fs/promises");
const verificationRepo = "/Users/abcd/Desktop/sierra_takehome";
const verificationRuns = await verificationFs.readdir(`${verificationRepo}/.audit/verification/runs`);
if (verificationRuns.length !== 1) throw new Error(`Expected one active verification run, found ${verificationRuns.length}`);
const verificationRunId = verificationRuns[0];
const verificationPort = Number((await verificationFs.readFile(`${verificationRepo}/.audit/verification/runs/${verificationRunId}/port`, "utf8")).trim());
const verificationEvidence = `${verificationRepo}/.audit/verification/evidence/${verificationRunId}`;
const verificationTab = await browser.tabs.new();
await verificationTab.goto(`http://127.0.0.1:${verificationPort}/`);
```

Stable controls and states:

- `getByLabel("Message Sierra Outfitters", { exact: true })` selects the composer.
- `getByRole("button", { name: "Send message", exact: true })` submits a turn.
- `getByRole("button", { name: "New conversation", exact: true })` clears the active browser conversation.
- `getByText("Trail guide online", { exact: true })` proves the browser reached an OpenAI-backed instance.
- `getByText("Sierra trail guide", { exact: true })` identifies assistant messages.
- `getByRole("link", { name: "Track with USPS", exact: true })` selects a tracking result.
- Starter cards fill the composer but do not submit it. Match them by their full visible prompt with a regular expression.

Use this product lookup to smoke-test the skill. It checks a stable catalog fact while allowing the model to choose its wording and stream chunk boundaries.

```js
await verificationTab.playwright.getByText("Trail guide online", { exact: true }).waitFor({ state: "visible", timeoutMs: 5000 });
const verificationComposer = verificationTab.playwright.getByLabel("Message Sierra Outfitters", { exact: true });
await verificationComposer.fill("Which Sierra Outfitters product has SKU SOTN002? Reply with its catalog name.");
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-action.dom.txt`, await verificationTab.playwright.domSnapshot());
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-action.jpg`, await verificationTab.screenshot({ fullPage: true }));
await verificationTab.playwright.getByRole("button", { name: "Send message", exact: true }).click();
const verificationResult = verificationTab.playwright.getByText("Crain's Summit Pro X Skis");
await verificationResult.waitFor({ state: "visible", timeoutMs: 60000 });
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-result.dom.txt`, await verificationTab.playwright.domSnapshot());
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-result.jpg`, await verificationTab.screenshot({ fullPage: true }));
await verificationTab.reload();
await verificationResult.waitFor({ state: "visible", timeoutMs: 10000 });
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-after-reload.dom.txt`, await verificationTab.playwright.domSnapshot());
await verificationFs.writeFile(`${verificationEvidence}/product-lookup-after-reload.jpg`, await verificationTab.screenshot({ fullPage: true }));
```

Read the matching feature file before driving another path. Do not use internal setters, inject browser storage, call test-only routes, or write directly to SQLite.

## Evidence

Proof lives at `.audit/verification/evidence/<run-id>/`. `launch.sh` writes `server.log` there. Browser drives add action, result, and reload DOM snapshots and screenshots. After a completed turn, capture the matching durable state:

```bash
./.agents/skills/verify-sierra-outfitters/scripts/capture-transcript.mjs "$verification_run_id"
./.agents/skills/verify-sierra-outfitters/scripts/doctor.sh "$verification_run_id" \
  | tee ".audit/verification/evidence/$verification_run_id/doctor.txt"
```

A valid proof contains the filled composer before submission, the completed assistant result, the same result after reload, and the SQLite transcript. Match facts instead of full generated sentences. Require the browser and database to agree on user text, assistant facts, message order, and pending state. Never require an exact number of streamed chunks.

The browser turn is a real OpenAI request and may incur cost. Keep the smoke run to one mapped feature unless the change affects more. For broader model behavior, use `npm run review:agent` against the OpenAI-backed server.

Never place `.env`, API keys, browser storage, request headers, or unrelated developer data in evidence.

## Cleanup

Close the agent-created browser tab, then stop only the recorded process:

```js
await verificationTab.close();
```

```bash
./.agents/skills/verify-sierra-outfitters/scripts/cleanup.sh "$verification_run_id"
test ! -d ".audit/verification/runs/$verification_run_id"
find ".audit/verification/evidence/$verification_run_id" -maxdepth 1 -type f -print | sort
```

`cleanup.sh` checks the PID, command, working directory, and recorded port before sending a signal. It removes only that run's disposable database and state directory. It never removes `.audit/verification/evidence/<run-id>`.

Run cleanup after every failed attempt. Never kill by process name. Never stop an instance that the current run did not launch.

## Helpers

All helpers are executable and run from any directory inside the checkout:

- `scripts/launch.sh <run-id> <port>` starts one attached, isolated OpenAI-backed instance and records its ownership data.
- `scripts/doctor.sh <run-id>` validates ownership, health mode, and build identity.
- `scripts/capture-transcript.mjs <run-id>` writes the newest conversation, messages, pending reply, and promotion grants to the evidence directory.
- `scripts/cleanup.sh <run-id>` stops the recorded instance and removes only its scratch state.
