# Early Risers

Early Risers grants one 10 percent code per conversation and Pacific calendar date only when the customer explicitly asks during the 8:00 through 10:00 AM Pacific window.

## Sub-features

- `promotion-explicit` recognizes a direct request to receive the promotion.
- `promotion-negated` does not claim a promotion that the customer rejected.
- `promotion-window` uses the server's current Pacific time.
- `promotion-grant` persists one code per conversation and Pacific date.
- `promotion-outside-window` creates no grant outside the window.

## How to get to it (user POV)

- Type an Early Risers request into **Message Sierra Outfitters**, then choose **Send message**.
- Choose the starter card containing `I want to claim the Early Risers promotion`, then choose **Send message**.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- Record the current time in `America/Los_Angeles` before the explicit request.
- Start the negated and explicit cases in different new conversations.

- Send `Do not claim the Early Risers promotion.` Require a reply that does not claim or display a promotion code. Capture the transcript and require `promotionGrants` to be empty.
- Send `Please give me the Early Risers promotion.` If Pacific time is from 8:00 inclusive to 10:00 exclusive, require one `promotionGrants` row and require its exact code to appear in the browser. Outside that window, require a reply that states the 8:00 to 10:00 AM Pacific limit and require no grant row.
- During the eligible window, repeat the explicit request in the same conversation. Require the same visible code and one database grant row for that Pacific date.
- Choose the starter card matching `/I want to claim the Early Risers promotion/`. Require the composer to contain that sentence before submitting it.
- Capture the filled request, completed reply, current Pacific time, and persisted transcript. The database row decides whether a grant occurred.

## Gotchas

- Do not change the machine clock or write a grant directly to SQLite. Outside the eligible window, report `promotion-grant` and `promotion-same-day` as time-blocked.
- The window follows `America/Los_Angeles`, not the workstation's displayed timezone.
- The starter prompt is explicit consent, but it only fills the composer.
- A success reply without a matching grant row fails verification.
