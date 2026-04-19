import { describe, expect, it } from "vitest";

import {
  candidateDateForAsk,
  decidedStartAt,
  deadlineFor,
  formatCandidateJa,
  isoWeekKey,
  parseCandidateDateIso
} from "../../src/time/index.js";

describe("time utilities", () => {
  it("builds ISO week keys across year boundaries", () => {
    // regression: 2021-01-01 は ISO 的には 2020-W53 に属する (年跨ぎ)。
    expect(isoWeekKey(new Date("2021-01-01T00:00:00+09:00"))).toBe("2020-W53");
    expect(isoWeekKey(new Date("2026-01-02T00:00:00+09:00"))).toBe("2026-W01");
    // regression: 2027-01-01 (金) と 2027-01-02 (土) は同一 ISO week (2026-W53) でなければならない。
    //   金曜 Session と翌土曜順延 Session が同じ weekKey を共有する前提。
    expect(isoWeekKey(new Date("2027-01-01T08:00:00+09:00"))).toBe("2026-W53");
    expect(isoWeekKey(new Date("2027-01-02T08:00:00+09:00"))).toBe("2026-W53");
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

  it("parses candidate date ISO string as JST midnight", () => {
    // jst: TZ=Asia/Tokyo 前提。UTC 解釈だと 9 時間ズレる。
    const parsed = parseCandidateDateIso("2026-04-24");
    expect(parsed.toISOString()).toBe("2026-04-23T15:00:00.000Z");
  });

  it("computes deadline at 21:30 JST on the candidate date", () => {
    const candidate = parseCandidateDateIso("2026-04-24");
    const deadline = deadlineFor(candidate);
    expect(deadline.toISOString()).toBe("2026-04-24T12:30:00.000Z");
  });

  it("picks the latest chosen time slot for decidedStartAt", () => {
    const candidate = parseCandidateDateIso("2026-04-24");
    // invariant: 全員の選択が揃っていれば最も遅いスロットを採用する。
    const start = decidedStartAt(candidate, ["T2200", "T2300", "T2230"]);
    expect(start?.toISOString()).toBe("2026-04-24T14:00:00.000Z");
  });

  it("returns undefined from decidedStartAt when no choices are given", () => {
    const candidate = parseCandidateDateIso("2026-04-24");
    expect(decidedStartAt(candidate, [])).toBeUndefined();
  });
});
