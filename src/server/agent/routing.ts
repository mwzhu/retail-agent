import type { ModelMessage, ToolDirective } from "./types";
import { hasExplicitPromotionIntent } from "./intents";

export function selectToolDirective(messages: readonly ModelMessage[]): ToolDirective {
  const userMessages = messages.filter(
    (message): message is Extract<ModelMessage, { kind: "text" }> =>
      message.kind === "text" && message.role === "user",
  );
  const currentRequest = userMessages.at(-1)?.content;
  if (currentRequest === undefined) return { kind: "none" };

  const userContext = userMessages.map((message) => message.content).join("\n");
  const completedTools = new Set(
    messages
      .filter((message) => message.kind === "tool_result")
      .map((message) => message.name),
  );
  const orderNumberPattern = /(?:#\s*)?[A-Z](?:\s*\d){3,}\b/i;
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(userContext);
  const hasOrderNumber = orderNumberPattern.test(userContext);
  const orderIntent = /\b(?:order|track|tracking)\b/i.test(currentRequest)
    || (hasEmail && orderNumberPattern.test(currentRequest));
  if (
    orderIntent
    && hasEmail
    && hasOrderNumber
    && !completedTools.has("lookup_order")
  ) {
    return { kind: "required", name: "lookup_order" };
  }

  const productIntent = /\b(?:recommend|product|catalog|gear|equipment|buy|price|cost|inventory|stock|carry|return|warranty|backpack|skis?|jetpack|cloak|lampshade|crampons)\b|\bSO[A-Z0-9]{5}\b/i;
  if (productIntent.test(currentRequest) && !completedTools.has("search_products")) {
    return { kind: "required", name: "search_products" };
  }

  const priorContext = userMessages.slice(0, -1).map((message) => message.content);
  const promotionIntent = hasExplicitPromotionIntent(currentRequest, priorContext);
  if (promotionIntent && !completedTools.has("claim_early_risers")) {
    return { kind: "required", name: "claim_early_risers" };
  }

  const handledIntent = (orderIntent && completedTools.has("lookup_order"))
    || (productIntent.test(currentRequest) && completedTools.has("search_products"))
    || (/\bearly\s+risers\b/i.test(currentRequest)
      && (!promotionIntent || completedTools.has("claim_early_risers")));
  return handledIntent ? { kind: "none" } : { kind: "auto" };
}
