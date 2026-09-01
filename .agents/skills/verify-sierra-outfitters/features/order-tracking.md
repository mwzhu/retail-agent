# Order tracking

Order tracking collects both required identifiers, returns a generic miss for invalid pairs, and shows stored status and tracking data for a match.

## Sub-features

- `orders-collect-identifiers` asks for the missing email and order number.
- `orders-cross-turn` combines identifiers supplied across conversation turns.
- `orders-match` finds a normalized email and order-number pair.
- `orders-tracking-link` exposes a USPS link only for a stored tracking number.
- `orders-generic-miss` does not reveal which identifier failed.

## How to get to it (user POV)

- Type an order question into **Message Sierra Outfitters**, then choose **Send message**.
- Choose the starter card containing `Help me track an order`, then choose **Send message**.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- Start each independent case with **New conversation**.

- Choose the starter card matching `/Help me track an order/`, then submit it. Require the reply to ask for both the email address and order number.
- Send `My order number is #W001.` Require the reply to ask for the missing email. Then send `The email is john.doe@example.com.` Require the completed reply to report the stored `delivered` status and show a link named **Track with USPS**.
- Require the tracked-order link `href` to equal `https://tools.usps.com/go/TrackConfirmAction?tLabels=TRK123456789`.
- Send `Track order #W003 for alice.johnson@example.com.` in a new conversation. Require the reply to report the stored `fulfilled` status and require no link named **Track with USPS**.
- Send `Track order #W001 for wrong@example.com.` in a new conversation. Require a generic miss. Reject any claim about which identifier failed and any disclosure of the real email, status, or tracking number.
- Capture each complete request before submission and the visible status plus link state after completion. Run `capture-transcript.mjs` after the selected proof case and match the stored messages to the browser.

## Gotchas

- The OpenAI path can combine an order number and email from separate turns.
- Order numbers include a leading `#`, though the store normalizes whitespace and case.
- Do not open the USPS link. Its exact `href` proves the rendered target without leaving the application.
- Some fixture orders reference products missing from the catalog. That does not prevent order status or tracking proof.
