# Conversation lifecycle

The browser restores a completed conversation after reload and lets a customer return to a fresh welcome screen without deleting the old SQLite transcript.

## Sub-features

- `conversation-create` creates a conversation on the first submitted turn.
- `conversation-reload` restores completed messages after page reload.
- `conversation-continue` appends later turns to the same transcript.
- `conversation-new` clears the active browser conversation and returns to welcome.
- `conversation-retain-old` keeps the prior conversation in SQLite after the browser starts a new one.

## How to get to it (user POV)

- Submit the first message from the welcome screen.
- Reload the page after a completed reply.
- Send another message from the restored transcript.
- Choose **New conversation** in the header.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- Start from the welcome screen and use a fresh verification database.

- Send `Which Sierra Outfitters product has SKU SOTN002? Reply with its catalog name.` Require a completed reply containing `Crain's Summit Pro X Skis`. Capture the result DOM and screenshot.
- Reload the page. Require the exact user question and `Crain's Summit Pro X Skis` to reappear. Require the welcome heading `How can we help you hit the trail?` to remain hidden.
- Send `Help me track an order`. Require the reply to ask for the missing email and order number. Run `capture-transcript.mjs` and require four ordered messages with roles `user`, `assistant`, `user`, `assistant`.
- Choose **New conversation**. Require the welcome heading and all three starter cards. Require the previous messages to disappear from the active browser view.
- Do not submit a message in the fresh state. Run `capture-transcript.mjs` again and require the prior four messages to remain unchanged.
- Keep the completed, reload, continued, and fresh welcome screenshots. Keep the persisted transcript after the browser reset.

## Gotchas

- **New conversation** clears browser state. It does not delete the old conversation from SQLite.
- Reload restores the conversation only after the first accepted turn stores its identifier and the assistant turn completes.
- The browser has no conversation sidebar. After **New conversation**, the old transcript is reachable only through the API or database evidence.
- A pending failed turn exposes **Retry reply**. To test it, use a real provider failure or interrupted connection and preserve the failed evidence. Do not simulate it through a fake model.
