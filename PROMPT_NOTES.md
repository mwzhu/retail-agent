# About the agent prompt

The prompt has four jobs. It defines the Sierra Outfitters voice, forces grounded tool use, protects customer data, and tells the model how to handle tool denials.

The first version emphasized outdoor enthusiasm. The next version forced one of four closings and the same mountain emoji onto every reply, which became repetitive. The current prompt asks for outdoor language frequently but not mechanically. The model creates context-fitting phrases and reserves varied emojis for upbeat successes. Bad news has no flourish or emoji.

The order rules require both email and order number. The model asks only for missing values and uses the matched result. It does not reveal which identifier failed. A raw `error` status becomes a neutral statement that a reliable shipping status is unavailable.

The product rules require catalog search before any answer about what to buy, gear, equipment, product qualities, or recommendations. The model receives no more than five records and cannot invent prices, policies, specifications, inventory, or SKUs. An empty result stays an honest catalog miss before any brief general guidance.

The promotion rules give the model the fixed percentage and Pacific hours for information-only answers. A claim requires an explicit current-turn request. Application code checks the Pacific window and issues the code. The model cannot provide the clock, conversation identity, or discount code as tool arguments.

The OpenAI adapter forces a required order or product call when the current request and conversation contain enough information. It also prevents repeated calls after a capability has returned a result. The model still writes the answer, but privacy-critical lookups and catalog verification do not depend on a probabilistic routing decision.

The final model call has no tools. It receives completed tool results and one instruction to answer the customer now. Both system messages include the same brand-voice instruction once. This keeps the streamed phase free of function-call states. The prompt requires plain text because the P0 client does not render Markdown.
