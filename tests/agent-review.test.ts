import { describe, expect, it } from "vitest";
import { brandCoverageChecks } from "../scripts/agent-review/brand-voice";

describe("brandCoverageChecks", () => {
  it("measures frequency only across replies eligible for brand voice", () => {
    const checks = brandCoverageChecks([
      ...makeTurns({ count: 8, brandVoice: "eligible", response: "Happy trails! 🏔️" }),
      { brandVoice: "eligible", response: "Your order is ready. Adventure awaits!" },
      { brandVoice: "eligible", response: "Your order is ready." },
      ...makeTurns({ count: 8, brandVoice: "prohibited", response: "That information is unavailable." }),
      { brandVoice: "prohibited", response: "Mountaineering crampons are unavailable." },
      {
        brandVoice: "prohibited",
        response: "That request is unclear. Ask me about outdoor equipment instead.",
      },
    ]);

    expect(checks.find((check) => check.title.startsWith("Outdoor voice"))?.passed).toBe(true);
    expect(checks.find((check) => check.title.startsWith("Outdoor emojis"))?.passed).toBe(true);
    expect(checks.find((check) => check.title.startsWith("Excluded replies"))?.passed).toBe(true);
  });

  it("rejects outdoor language on replies where brand voice is prohibited", () => {
    const checks = brandCoverageChecks([
      ...makeTurns({ count: 7, brandVoice: "eligible", response: "Happy trails! 🏔️" }),
      ...makeTurns({ count: 3, brandVoice: "eligible", response: "Your order is ready." }),
      { brandVoice: "prohibited", response: "That information is unavailable. Happy trails!" },
    ]);

    expect(checks.find((check) => check.title.startsWith("Excluded replies"))?.passed).toBe(false);
  });
});

function makeTurns({
  count,
  brandVoice,
  response,
}: {
  readonly count: number;
  readonly brandVoice: "eligible" | "prohibited";
  readonly response: string;
}) {
  return Array.from({ length: count }, () => ({ brandVoice, response }));
}
