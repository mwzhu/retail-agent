# About the agent prompt

The prompt has four jobs. It defines the Sierra Outfitters voice, forces grounded tool use, protects customer data, and tells the model how to handle tool denials.

The first version emphasized outdoor enthusiasm. That instruction alone can make every sentence sound like marketing copy. The current prompt limits each response to one outdoor flourish while keeping the answer concise.

The order rules require both email and order number. The model asks for missing values together and uses only the matched tool result. It does not reveal which identifier failed. A raw `error` status becomes a neutral statement that a reliable shipping status is unavailable.

The product rules require catalog search before a recommendation. The model receives no more than five records and cannot invent price, specifications, inventory, or SKUs. An empty result stays an honest catalog miss.

The promotion rules require an explicit current-turn request. Application code checks the Pacific window and issues the code. The model cannot provide the clock, conversation identity, or discount code as tool arguments.

The final model call has no tools. It receives completed tool results and one instruction to answer the customer now. This keeps the streamed phase free of function-call states.
