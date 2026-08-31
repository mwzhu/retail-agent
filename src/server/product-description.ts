export const MAX_PRODUCT_DESCRIPTION_CHARACTERS = 240;

export function summarizeProductDescription(description: string): string {
  if (description.length <= MAX_PRODUCT_DESCRIPTION_CHARACTERS) return description;

  const candidate = description.slice(0, MAX_PRODUCT_DESCRIPTION_CHARACTERS - 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const completeWords = wordBoundary > 0 ? candidate.slice(0, wordBoundary) : candidate;
  return `${completeWords.trimEnd()}…`;
}
