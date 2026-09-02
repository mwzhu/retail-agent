# Conversation lifecycle

The browser restores completed and accepted-but-incomplete conversations after reload. It lets a customer retry a saved pending turn or return to a fresh welcome screen without deleting the old SQLite transcript.

## Sub-features

- `conversation-create` creates a conversation on the first submitted turn.
- `conversation-reload` restores completed messages after page reload.
- `conversation-pending-reload` restores an accepted user message and pending reply after an interrupted connection.
- `conversation-retry` completes the saved pending turn without duplicating its user message.
- `conversation-continue` appends later turns to the same transcript.
- `conversation-new` clears the active browser conversation and returns to welcome.
- `conversation-retain-old` keeps the prior conversation in SQLite after the browser starts a new one.

## How to get to it (user POV)

- Submit the first message from the welcome screen.
- Reload the page after a completed reply.
- Reload after a real interrupted connection leaves the accepted user message pending, then choose **Retry reply**.
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
- In another new conversation, submit a product request and reload as soon as the accepted user message appears, before its reply completes. Require the exact user message and **Retry reply** after reload. Capture one persisted user message and a non-null `pendingReply`.
- Run the doctor, choose **Retry reply**, and require a completed assistant message. Capture two ordered messages with roles `user`, `assistant` and a null `pendingReply`.
- Keep the completed, reload, continued, and fresh welcome screenshots. Keep the persisted transcript after the browser reset.

## Gotchas

- **New conversation** clears browser state. It does not delete the old conversation from SQLite.
- Reload recovery begins when the first accepted turn stores its identifier. A completed turn restores both messages; an incomplete turn restores the user message and **Retry reply**.
- The browser has no conversation sidebar. After **New conversation**, the old transcript is reachable only through the API or database evidence.
- To create a pending turn, use a real provider failure or interrupt the live connection after the accepted user message appears. Preserve the pending evidence and clean it by retrying or resetting. Do not simulate it through a fake model.
