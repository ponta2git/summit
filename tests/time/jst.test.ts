import { describe, expect, it } from "vitest";

import { candidateDateForAsk, formatCandidateJa, isoWeekKey } from "../../src/time/index.js";

describe("time utilities", () => {
  it("builds ISO week keys across year boundaries", () => {
    expect(isoWeekKey(new Date("2021-01-01T00:00:00+09:00"))).toBe("2020-W53");
    expect(isoWeekKey(new Date("2026-01-02T00:00:00+09:00"))).toBe("2026-W01");
  });

  it("returns the input date as candidate date for /ask", () => {
    const samples = [
      new Date("2026-04-20T09:00:00+09:00"),
      new Date("2026-04-24T18:00:00+09:00"),
      new Date("2026-04-26T23:59:00+09:00")
    ];

    for (const sample of samples) {
      expect(candidateDateForAsk(sample)).toBe(sample);
    }
  });

  it("formats candidate date in Japanese short weekday format", () => {
    expect(formatCandidateJa(new Date("2026-04-24T22:00:00+09:00"))).toBe(
      "2026-04-24(金) 22:00 以降"
    );
  });
});
