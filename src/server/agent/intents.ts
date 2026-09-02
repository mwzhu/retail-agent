export function hasExplicitPromotionIntent(
  content: string,
  priorContext: readonly string[] = [],
): boolean {
  const namedPromotion = "early\\s+riser(?:s)?(?:\\s+(?:promotion|promo|discount))?";
  const contextualPromotion = "(?:this|that|the)\\s+(?:promotion|promo|discount|deal)";
  const priorNamesEarlyRisers = priorContext.some((message) =>
    /\bearly\s+riser(?:s)?\b/i.test(message));
  const promotion = priorNamesEarlyRisers
    ? `(?:${namedPromotion}|${contextualPromotion})`
    : namedPromotion;
  const refusal = new RegExp(
    `\\b(?:do\\s+not|don['’]?t|never)\\b[^.!?]{0,80}\\b(?:claim|receive|redeem|get|give|send)\\b[^.!?]{0,80}\\b${promotion}\\b`,
    "i",
  );
  if (refusal.test(content)) return false;

  return [
    `\\b(?:claim|receive|redeem)\\s+(?:the\\s+)?${promotion}\\b`,
    `\\b(?:give|send)\\s+me\\s+(?:the\\s+)?${promotion}\\b`,
    `\\b(?:can|could|may)\\s+i\\s+(?:get|claim|receive)\\s+(?:the\\s+)?${promotion}\\b`,
    `\\bi(?:\\s+want|(?:'d|’d|\\s+would)\\s+like)\\s+(?:to\\s+(?:claim|receive|get)\\s+)?(?:the\\s+)?${promotion}\\b`,
  ].some((pattern) => new RegExp(pattern, "i").test(content));
}

export function hasExplicitInventoryIntent(content: string): boolean {
  return [
    /\bhow\s+many\b/i,
    /\b(?:inventory|stock)\s+(?:count|level|number|quantit(?:y|ies))\b/i,
    /\b(?:count|level|number|quantit(?:y|ies))\s+(?:in|of|for)\s+(?:the\s+)?(?:inventory|stock)\b/i,
    /\b(?:what(?:'s|\s+is)|show|tell\s+me|give\s+me)\b[^.!?]{0,30}\binventory\b/i,
    /^\s*(?:current\s+)?inventory\s+(?:for|of)\b/i,
    /\b\d[\d,]*\s+(?:units?|items?)\b/i,
    /\b\d[\d,]*\s+(?:available|in[\s-]?stock|left)\b/i,
  ].some((pattern) => pattern.test(content));
}

export function foodProductSearchQuery(content: string): string | null {
  if (/\b(?:hungry|starving|thirsty)\b/i.test(content)) {
    return "food beverage snack energy protein";
  }
  const namesFood = /\b(?:food|snacks?|meals?|beverages?|drinks?|protein\s+bars?|energy\s+drinks?)\b/i
    .test(content);
  const requestsCatalogHelp = /\b(?:recommend(?:ation)?s?|suggest(?:ion)?s?|options?|products?|catalog|inventory|carry|sell|offer)\b/i
    .test(content)
    || /\bdo\s+you\s+have\b/i.test(content);
  return namesFood && requestsCatalogHelp
    ? "food beverage snack energy protein"
    : null;
}
