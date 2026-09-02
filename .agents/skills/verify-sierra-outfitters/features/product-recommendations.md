# Product recommendations

Product recommendations let a customer describe needed gear, food, or drinks and receive facts grounded in Sierra Outfitters' local catalog. Inventory counts reach the reply model only when the current request explicitly asks for or alleges a count.

## Sub-features

- `products-direct` sends a typed catalog question.
- `products-starter` enters through the Gear starter card.
- `products-sku` resolves an exact SKU to its catalog record.
- `products-food` treats hunger, food, snack, drink, and thirst requests as catalog searches.
- `products-inventory-explicit` returns a grounded count when the customer explicitly asks for inventory.
- `products-inventory-omitted` withholds counts from the reply model when the customer did not ask for them.
- `products-no-match` reports an absent catalog item without inventing one.
- `products-persisted` stores the exact user question and generated assistant reply.

## How to get to it (user POV)

- Type a gear or SKU question into **Message Sierra Outfitters**, then choose **Send message**.
- Ask for food or a drink, including plain requests such as `I'm hungry.`.
- Ask for a catalog inventory count or correct an alleged count.
- Choose the starter card containing `Recommend gear for a winter adventure`, then choose **Send message**.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- The welcome screen is visible with no messages.

- Send `Which Sierra Outfitters product has SKU SOTN002? Reply with its catalog name.` Require the completed reply to contain `Crain's Summit Pro X Skis`.
- Reload immediately after the SOTN002 reply. Require the exact user question and `Crain's Summit Pro X Skis` to reappear. Run `capture-transcript.mjs` before creating another conversation. Require two ordered messages, no pending reply, and the same user text and product fact as the browser.
- Start a new conversation. Choose the button whose accessible name matches `/Recommend gear for a winter adventure/`. Require the composer to contain that prompt before submission. After submission, require the completed reply to contain at least one exact name from `ProductCatalog.json`.
- Start a new conversation and send `Does Sierra Outfitters carry SKU SOZZ999?`. Require a clear catalog miss. Reject a reply that claims any SKU, price, inventory value, or product name not present in `ProductCatalog.json`.
- Start a new conversation and send `I'm hungry. Recommend a food or drink product and tell me its catalog inventory.` Require a completed reply containing `Zack's Bulk Up Protein Bars` with `catalog inventory is 14`, or `Beth's Caffeinated Energy Drink` with `catalog inventory is 300`.
- Start a new conversation and send `Recommend a Sierra Outfitters catalog snack.` Require an exact food or drink name from `ProductCatalog.json` and reject any inventory count.
- Save action, result, and reload DOM snapshots and screenshots under `.audit/verification/evidence/<run-id>/`. Keep the persisted transcript beside them.

## Gotchas

- The Gear starter card fills the composer but does not send the message.
- OpenAI controls prose and chunk boundaries. Match facts, not complete sentences.
- Use an exact SKU for the smoke run. Broad gear requests may validly return several products.
- The server normalizes hunger and food requests to a catalog search even when the planner misses them.
- Inventory means the catalog's recorded count. It does not prove that an item can be purchased.
- Wait up to 60 seconds for a completed provider response. Stop on a visible error instead of retrying silently.
