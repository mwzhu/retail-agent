export function hasExplicitPromotionIntent(
  content: string,
  priorContext: readonly string[] = [],
): boolean {
  const namedPromotion = "early\\s+risers(?:\\s+(?:promotion|promo|discount))?";
  const contextualPromotion = "(?:this|that|the)\\s+(?:promotion|promo|discount|deal)";
  const priorNamesEarlyRisers = priorContext.some((message) =>
    /\bearly\s+risers\b/i.test(message));
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
