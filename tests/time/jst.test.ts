import { describe, expect, it } from "vitest";

import {
  candidateDateForAsk,
  decidedStartAt,
  deadlineFor,
  formatCandidateJa,
  isoWeekKey,
  parseCandidateDateIso,
  postponeDeadlineFor,
  saturdayCandidateFrom
} from "../../src/time/index.js";

describe("time utilities", () => {
  it("builds ISO week keys across year boundaries", () => {
    // regression: 2021-01-01 は ISO 的には 2020-W53 に属する (年跨ぎ)。
    expect(isoWeekKey(new Date("2021-01-01T00:00:00+09:00"))).toBe("2020-W53");
    expect(isoWeekKey(new Date("2026-01-02T00:00:00+09:00"))).toBe("2026-W01");
  });

  // regression: 金曜 Session と翌土曜順延 Session は同一 weekKey を共有しなければならない。
  //   calendar year 跨ぎ (Fri=12/31 / Sat=01/01) や ISO W53 年 (2026/2032 isoYear) で暦年と
  //   ISO year が乖離するケースが仕様上最もズレやすい。2024–2035 の境界ペアを網羅。
  // iso-week: date-fns/getISOWeekYear + getISOWeek の併用が守られているかを検証する invariant。
  // @see src/time/index.ts isoWeekKey, requirements/base.md §2 (weekKey)
  describe.each<{
    label: string;
    fri: string;
    sat: string;
    weekKey: string;
  }>([
    // 年跨ぎ + ISO W53 (Fri が 12/31、Sat が 01/01、両日とも前暦年の W53)
    { label: "2026→2027 boundary (W53)", fri: "2026-12-31", sat: "2027-01-01", weekKey: "2026-W53" },
    // 年跨ぎ + ISO W52 (Fri が 12/31、Sat が 01/01、両日とも前暦年の W52)
    { label: "2027→2028 boundary (W52)", fri: "2027-12-31", sat: "2028-01-01", weekKey: "2027-W52" },
    // 年跨ぎ + ISO W53 (2032 は 53 週年)
    { label: "2032→2033 boundary (W53)", fri: "2032-12-31", sat: "2033-01-01", weekKey: "2032-W53" },
    // 暦年内だが Jan 第1週 / Dec 最終週 (ISO year は暦年と一致)
    { label: "2025 first week", fri: "2025-01-03", sat: "2025-01-04", weekKey: "2025-W01" },
    { label: "2025 last week", fri: "2025-12-26", sat: "2025-12-27", weekKey: "2025-W52" },
    { label: "2028 first week", fri: "2028-01-07", sat: "2028-01-08", weekKey: "2028-W01" },
    { label: "2030 last week", fri: "2030-12-27", sat: "2030-12-28", weekKey: "2030-W52" },
    { label: "2034 first week", fri: "2034-01-06", sat: "2034-01-07", weekKey: "2034-W01" },
    { label: "2035 last week", fri: "2035-12-28", sat: "2035-12-29", weekKey: "2035-W52" }
  ])("Fri/Sat pair shares weekKey: $label", ({ fri, sat, weekKey }) => {
    it(`${fri} (Fri) → ${weekKey}`, () => {
      expect(isoWeekKey(new Date(`${fri}T08:00:00+09:00`))).toBe(weekKey);
    });
    it(`${sat} (Sat) → ${weekKey}`, () => {
      expect(isoWeekKey(new Date(`${sat}T08:00:00+09:00`))).toBe(weekKey);
    });
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

  describe("postponeDeadlineFor", () => {
    it("computes 00:00 JST on Saturday from a Friday candidate date", () => {
      const friday = parseCandidateDateIso("2026-04-24");
      expect(postponeDeadlineFor(friday).toISOString()).toBe("2026-04-24T15:00:00.000Z");
    });

    it("keeps year-boundary handling (2022-12-30 -> 2022-12-31 00:00 JST)", () => {
      // iso-week: 年跨ぎ直前の金曜候補日でも翌日 00:00 JST を正しく返す。
      const friday = parseCandidateDateIso("2022-12-30");
      expect(postponeDeadlineFor(friday).toISOString()).toBe("2022-12-30T15:00:00.000Z");
    });
  });

  describe("saturdayCandidateFrom", () => {
    it("computes Saturday 00:00 JST from Friday 00:00 JST", () => {
      const friday = parseCandidateDateIso("2026-04-24");
      expect(saturdayCandidateFrom(friday).toISOString()).toBe("2026-04-24T15:00:00.000Z");
    });
  });
});
