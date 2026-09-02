# Sierra Outfitters verification map

This directory is the maintained source for proving Sierra Outfitters through its customer-facing chat. Read this index first, then drive every entry point listed by the selected feature file.

## Baseline preconditions

- Build the browser bundle with `npm run build`.
- Launch one isolated instance with `scripts/launch.sh <run-id> <port>`.
- Supply `OPENAI_API_KEY` through the inherited environment or the ignored root `.env`.
- Use a new run ID, a free port, and the disposable database chosen by the launcher.
- Require `scripts/doctor.sh <run-id>` to pass before browser work.
- Open the exact URL printed by the launcher through the Codex Browser skill.
- Require the header status `Trail guide online` before sending a message.
- Never drive an instance that the current verification run did not start.

## Driving conventions

- Start from the welcome screen unless a recipe says to continue the same conversation.
- Use **New conversation** to clear browser state between independent cases.
- Prefer the composer label, button role and name, rendered facts, and tracking-link name over CSS classes or DOM position.
- Starter cards only fill the composer. Submission is a separate user action.
- Wait for a stable expected fact. Do not use a fixed delay or a chunk count as proof.
- Allow generated wording to vary. Assert catalog, order, promotion, and persistence facts.

## Proof and skip reporting

- Capture the filled composer before submission and the completed assistant result.
- Include the `Sierra Outfitters` identity and `Trail guide online` status in browser screenshots.
- Reload completed conversations and capture the restored result when persistence is part of the feature.
- Run `capture-transcript.mjs` after mutations. Match the browser's user and assistant facts to its output.
- For Early Risers, treat the `promotionGrants` rows as the grant authority.
- Report every untested entry point by name. Do not treat a different path as equivalent proof.
- Keep proof artifacts after cleanup.

## Feature entry contract

Each feature file describes behavior from the customer's point of view and contains exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with Browser`
4. `Gotchas`

## Features

- [Product recommendations](./product-recommendations.md) covers direct questions, the Gear starter card, food and drink requests, inventory disclosure, catalog matches, and no-match replies.
- [Order tracking](./order-tracking.md) covers identifier collection, matched and missing orders, status text, USPS links, purchased items, and order-based recommendations.
- [Early Risers](./early-risers.md) covers promotion information, explicit consent, negated requests, the Pacific-time window, durable grants, and same-day code recovery.
- [Conversation lifecycle](./conversation-lifecycle.md) covers completed and pending-turn persistence, reload recovery, retry, and starting a new browser conversation.
- [Assistant response policy](./response-policy.md) covers Sierra voice, calm clarification and bad-news replies, unsupported retail facts, and unsupported order or payment actions.
