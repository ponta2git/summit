import { describe, expect, it } from "vitest";
import { capacityPartAnalysis } from "../../scripts/perf/notificationPerformance.parts.ts";
import { validateNewNotification } from "../../src/domain/resultNotificationPayload.ts";
import { assertNewNotificationPartLimit, planResultNotification } from "../../src/features/result-notifications/render.ts";
import { buildNotificationLinks } from "../../src/features/result-notifications/links.ts";
import { semanticJson } from "../testing/ports.resultNotifications.state.ts";

const origin = "https://results.example.com";

describe("high-part notification performance fixture", () => {
  it("reaches accepted field and URL boundaries while remaining below the payload and part budgets", () => {
    const payload = capacityPartAnalysis("performance-parts-maximum");
    expect(validateNewNotification(payload)).toStrictEqual(payload);
    expect(() => assertNewNotificationPartLimit(payload, origin)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(196_013);
    // This fixture has no exponent-form numbers; semanticJson matches JSONB text length.
    expect(Buffer.byteLength(semanticJson(payload))).toBe(200_210);
    expect(payload.data.matches).toHaveLength(50);
    expect(payload.data.seasons).toHaveLength(16);
    expect(new Set(payload.data.matches.map(match => match.matchId)).size).toBe(50);
    const links = buildNotificationLinks(origin);
    for (const match of payload.data.matches) {
      expect(match.matchId.length).toBe(200);
      expect(links.match(match.matchId).length).toBe(1_802); // Angle brackets surround the 1,800-character URL.
      expect(match.ginjiTotal).toBe(9_007_199_254_740_988);
    }
    const plan = planResultNotification(payload, origin);
    expect(plan.partCount).toBe(112);
    let count = 0;
    let maximumLength = 0;
    let finalContent = "";
    for (const part of plan.parts()) {
      count += 1;
      maximumLength = Math.max(maximumLength, part.content.length);
      finalContent = part.content;
      expect(part.content.startsWith(`分析完了 ${count}/112`)).toBe(true);
    }
    expect(count).toBe(112);
    expect(maximumLength).toBe(1_908);
    expect(finalContent).toContain("最新の分析を確認:");
  });

  it("keeps source IDs stable while separating each run's notification identity", () => {
    const first = capacityPartAnalysis("performance-parts-first");
    const second = capacityPartAnalysis("performance-parts-second");
    expect(second.notificationId).not.toBe(first.notificationId);
    expect(second.data.matches.map(match => match.matchId)).toEqual(first.data.matches.map(match => match.matchId));
    expect(second.data.matches).not.toBe(first.data.matches);
  });
});
