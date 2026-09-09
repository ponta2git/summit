import { describe, expect, it } from "vitest";
import { validateNewNotification } from "../../src/domain/resultNotificationPayload.ts";
import { analysisNotification, ocrNotification } from "../features/result-notifications/fixtures.ts";

describe("result notification payload v1", () => {
  it("preserves bigint decimal strings, notes and unrounded deltas", () => {
    expect(validateNewNotification(ocrNotification())).toEqual(ocrNotification());
    expect(validateNewNotification(analysisNotification())).toEqual(analysisNotification());
  });

  it.each(["-1", "01", "9223372036854775808", "abc", "", "1e3"])("rejects invalid settings generation %s", generation => {
    expect(() => validateNewNotification({ ...ocrNotification(), settingsGeneration: generation })).toThrow("invalid_input");
  });

  it("rejects invalid calendar dates, noncanonical timestamps and mismatched IDs", () => {
    const payload = ocrNotification();
    for (const occurredAt of ["2026-02-30T12:00:00.000Z", "2026-09-09T12:00:00Z", "2026-09-09T21:00:00.000+09:00"]) {
      expect(() => validateNewNotification({ ...payload, occurredAt })).toThrow("invalid_input");
    }
    expect(() => validateNewNotification({ ...payload, notificationId: "result:ocr_completed:other-job" })).toThrow("invalid_input");
    expect(() => validateNewNotification({ ...payload, data: { ...payload.data, context: { ...payload.data.context, heldDateIso: "2026-02-30" } } })).toThrow("invalid_input");
  });

  it("rejects incomplete or inconsistent B snapshots without recomputing analytics", () => {
    const original = analysisNotification();
    const payloads = [
      { ...original, data: { ...original.data, overall: original.data.overall.slice(0, 3) } },
      { ...original, data: { ...original.data, overall: [original.data.overall[0], ...original.data.overall.slice(0, 3)] } },
      { ...original, data: { ...original.data, matches: [...original.data.matches, ...original.data.matches] } },
      { ...original, data: { ...original.data, matches: original.data.matches.map(match => ({ ...match, ginjiTotal: 999 })) } },
      { ...original, data: { ...original.data, disposition: "reused" } },
      { ...original, data: { ...original.data, overall: original.data.overall.map(rank => ({ ...rank, comparison: "unknown" })) } }
    ];
    for (const payload of payloads) { expect(() => validateNewNotification(payload)).toThrow("invalid_input"); }
  });

  it("accepts initial, empty, incomparable and reused comparisons with their distinct null semantics", () => {
    const original = analysisNotification();
    const ranks = original.data.overall.map((rank, index) => index === 0
      ? { ...rank, comparison: "initial", before: null, delta: null }
      : index === 1 ? { ...rank, comparison: "empty", after: { matchCount: 0, averageRank: null }, delta: null }
      : index === 2 ? { ...rank, comparison: "incomparable", delta: null }
      : { ...rank, comparison: "reused", before: rank.after, delta: 0 });
    const payload = { ...original, data: { ...original.data, overall: ranks } };
    expect(validateNewNotification(payload).data).toMatchObject({ overall: ranks });
  });
});
