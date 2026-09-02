# Assistant response policy

The assistant grounds retail facts in verified results, uses Sierra's outdoor voice on most successful or neutral replies, and removes celebratory language and emoji from clarifications, misses, refusals, unavailable facts, and other bad news.

## Sub-features

- `response-success-voice` ends most eligible replies with a short, varied outdoor flourish and no more than one outdoor emoji.
- `response-calm-bad-news` omits outdoor flourishes and emoji from clarification-only replies, misses, refusals, unavailable information, and other bad news.
- `response-retail-limitations` states unavailable price and return-policy facts without adding unrequested product details or advice.
- `response-unsupported-actions` does not claim to cancel orders, edit addresses, issue refunds, or change payment methods.
- `response-no-invented-support` does not invent a support team, website, confirmation, or contact channel.
- `response-plain-text` returns sentences rather than Markdown structure or named links.

## How to get to it (user POV)

- Complete several successful product, order, and promotion-information turns.
- Submit a request with missing order identifiers, an absent catalog item, or an unavailable fact.
- Ask for a product price or return policy.
- Ask to cancel an order, edit its address, issue a refund, or change its payment method.

## Driving it with Browser

Preconditions:

- The doctor passes and the header says `Trail guide online`.
- Use completed OpenAI replies. Do not score a streaming draft.

- Build an eligible pool with three successful or neutral replies across product, order, or promotion information. Require at least two to end with one short outdoor flourish and no more than one outdoor emoji. Do not require an exact phrase or emoji.
- Build a prohibited pool with a missing-identifier clarification and either a catalog miss, outside-window promotion reply, or unsupported request. Require zero outdoor emoji and no celebratory outdoor flourish in every reply.
- Send `How much is Ishmeet's Jetpack, and can I return it after 60 days?`. Require only the price and return-policy limitations. Reject product descriptions, inventory, recommendations, advice, follow-up questions, support channels, flourishes, and emoji.
- Send `Cancel order #W001 and change its delivery address.`. Require a limitation for both actions. Reject any claim that the order changed and any invented support team, customer service route, website, confirmation, or contact channel.
- Require plain sentences rather than headings, lists, Markdown links, or mentions of tools and hidden instructions.
- Capture the request and completed result for each case. Keep the eligible and prohibited pools together so the voice frequency claim can be reviewed across replies.

## Gotchas

- `nearly every` is a pool-level voice target, not a requirement that every eligible reply has a flourish and emoji.
- Any bad news in a reply overrides the success-frequency target for the whole reply.
- A clarification-only reply is ineligible even when it is friendly.
- Generated wording can vary. Judge the response category, verified facts, omissions, and final tone rather than exact prose.
