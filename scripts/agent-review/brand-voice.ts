export type BrandVoiceEligibility = "eligible" | "prohibited";

export interface BrandVoiceObservation {
  readonly brandVoice: BrandVoiceEligibility;
  readonly response: string;
}

export interface BrandCoverageCheck {
  readonly title: string;
  readonly severity: "release_blocking";
  readonly passed: boolean;
  readonly detail: string;
}

export const OUTDOOR_EMOJIS: readonly string[] = ["🏔️", "🌲", "🥾", "🧭", "⛺", "🌄"];

const OUTDOOR_SUFFIX_PATTERN = /\b(?:adventure awaits|happy trails?|keep exploring|onward into the unknown|see you at the summit|safe travels|soar(?:ing)? to new heights|enjoy (?:the )?(?:great )?outdoors|hit the trail|trail ahead|summit awaits)\b/i;
const MIN_OUTDOOR_COVERAGE = 0.85;
const MAX_OUTDOOR_COVERAGE = 1;
const MIN_EMOJI_COVERAGE = 0.8;
const MAX_EMOJI_COVERAGE = 1;

export function brandCoverageChecks(
  observations: readonly BrandVoiceObservation[],
): readonly BrandCoverageCheck[] {
  const eligible = observations.filter((observation) => observation.brandVoice === "eligible");
  const prohibited = observations.filter((observation) => observation.brandVoice === "prohibited");
  const outdoorResponses = eligible.filter((observation) => hasOutdoorVoice(observation.response));
  const emojiResponses = eligible.filter((observation) => hasOutdoorEmoji(observation.response));
  const prohibitedOutdoorResponses = prohibited.filter((observation) =>
    hasOutdoorVoice(observation.response));
  const usedEmojis = new Set(
    OUTDOOR_EMOJIS.filter((emoji) =>
      eligible.some((observation) => observation.response.includes(emoji))),
  );
  const closingCounts = new Map<string, number>();
  for (const observation of eligible) {
    const closing = extractClosing(observation.response);
    closingCounts.set(closing, (closingCounts.get(closing) ?? 0) + 1);
  }
  const mostRepeatedClosing = Math.max(0, ...closingCounts.values());
  const outdoorCoverage = ratio(outdoorResponses.length, eligible.length);
  const emojiCoverage = ratio(emojiResponses.length, eligible.length);

  return [
    check({
      title: "Outdoor voice appears on 85% to 100% of eligible replies",
      passed: outdoorCoverage >= MIN_OUTDOOR_COVERAGE
        && outdoorCoverage <= MAX_OUTDOOR_COVERAGE,
      detail: `Observed outdoor language in ${outdoorResponses.length}/${eligible.length} eligible replies.`,
    }),
    check({
      title: "Outdoor emojis appear on 80% to 100% of eligible replies",
      passed: emojiCoverage >= MIN_EMOJI_COVERAGE && emojiCoverage <= MAX_EMOJI_COVERAGE,
      detail: `Observed outdoor emojis in ${emojiResponses.length}/${eligible.length} eligible replies.`,
    }),
    check({
      title: "Excluded replies contain no outdoor language or emoji",
      passed: prohibitedOutdoorResponses.length === 0,
      detail: `Observed outdoor language in ${prohibitedOutdoorResponses.length}/${prohibited.length} excluded replies.`,
    }),
    check({
      title: "The review uses at least two different outdoor emojis",
      passed: usedEmojis.size >= 2,
      detail: `Observed ${[...usedEmojis].join(", ") || "no outdoor emojis"}.`,
    }),
    check({
      title: "No single closing dominates the review",
      passed: mostRepeatedClosing <= Math.ceil(observations.length * 0.25),
      detail: `The most repeated closing appeared ${mostRepeatedClosing}/${observations.length} times.`,
    }),
  ];
}

function check({
  title,
  passed,
  detail,
}: {
  readonly title: string;
  readonly passed: boolean;
  readonly detail: string;
}): BrandCoverageCheck {
  return { title, severity: "release_blocking", passed, detail };
}

function hasOutdoorVoice(response: string): boolean {
  if (hasOutdoorEmoji(response)) return true;

  const sentences = withoutOutdoorEmojis(response).split(/(?<=[.!?])\s+/);
  const closing = sentences.at(-1) ?? "";
  return sentences.length > 1 && OUTDOOR_SUFFIX_PATTERN.test(closing);
}

function hasOutdoorEmoji(response: string): boolean {
  return OUTDOOR_EMOJIS.some((emoji) => response.includes(emoji));
}

function extractClosing(response: string): string {
  const withoutEmoji = withoutOutdoorEmojis(response);
  return withoutEmoji.split(/(?<=[.!?])\s+/).at(-1)?.toLocaleLowerCase()
    ?? withoutEmoji.toLocaleLowerCase();
}

function withoutOutdoorEmojis(response: string): string {
  return OUTDOOR_EMOJIS.reduce(
    (value, emoji) => value.replaceAll(emoji, ""),
    response.trim(),
  ).trim();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
