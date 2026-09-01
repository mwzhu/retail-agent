# Product recommendations

Product recommendations let a customer describe needed gear and receive facts grounded in Sierra Outfitters' local catalog.

## Sub-features

- `products-direct` sends a typed catalog question.
- `products-starter` enters through the Gear starter card.
- `products-sku` resolves an exact SKU to its catalog record.
- `products-no-match` reports an absent catalog item without inventing one.
- `products-persisted` stores the exact user question and generated assistant reply.

## How to get to it (user POV)

- Type a gear or SKU question into **Message Sierra Outfitters**, then choose **Send message**.
- Choose the starter card containing `Recommend gear for a winter adventure`, then choose **Send message**.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- The welcome screen is visible with no messages.

- Send `Which Sierra Outfitters product has SKU SOTN002? Reply with its catalog name.` Require the completed reply to contain `Crain's Summit Pro X Skis`.
- Choose the button whose accessible name matches `/Recommend gear for a winter adventure/`. Require the composer to contain that prompt before submission. After submission, require the reply to contain at least one exact name from `ProductCatalog.json`.
- Start a new conversation and send `Does Sierra Outfitters carry SKU SOZZ999?`. Require a clear catalog miss. Reject a reply that claims any SKU, price, inventory value, or product name not present in `ProductCatalog.json`.
- Reload after the SOTN002 reply. Require the exact user question and `Crain's Summit Pro X Skis` to reappear. Run `capture-transcript.mjs`. Require two ordered messages, no pending reply, and the same user text and product fact as the browser.
- Save action, result, and reload DOM snapshots and screenshots under `.audit/verification/evidence/<run-id>/`. Keep the persisted transcript beside them.

## Gotchas

- The Gear starter card fills the composer but does not send the message.
- OpenAI controls prose and chunk boundaries. Match facts, not complete sentences.
- Use an exact SKU for the smoke run. Broad gear requests may validly return several products.
- Wait up to 60 seconds for a completed provider response. Stop on a visible error instead of retrying silently.
