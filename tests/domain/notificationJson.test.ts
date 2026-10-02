import { describe, expect, it, vi } from "vitest";
import { parseNotificationJson, validateNewNotification, validateStoredNotification } from "../../src/domain/resultNotificationPayload.ts";
import { RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES } from "../../src/notifications/config.ts";
import { analysisNotification, ocrNotification } from "../features/result-notifications/fixtures.ts";

describe("notification JSON allocation boundary", () => {
  it("does not count quoted or escaped punctuation as structural complexity", () => {
    const value = { note: '{[\\"],}'.repeat(200_000) };
    expect(parseNotificationJson(JSON.stringify(value))).toEqual(value);
  });

  it("accepts the depth boundary but rejects excessive nesting before allocation", () => {
    const allowed = "[".repeat(64) + "0" + "]".repeat(64);
    expect(JSON.stringify(parseNotificationJson(allowed))).toBe(allowed);
    const parse = vi.spyOn(JSON, "parse");
    expect(() => parseNotificationJson("[".repeat(65) + "0" + "]".repeat(65))).toThrow("payload_too_large");
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["[" + "{},".repeat(500_000) + "{}]", "[" + "0,".repeat(1_000_000) + "0]"])(
    "rejects excessive containers or primitive values before JSON.parse creates them", raw => {
      const parse = vi.spyOn(JSON, "parse");
      expect(() => parseNotificationJson(raw)).toThrow("payload_too_large");
      expect(parse).not.toHaveBeenCalled();
    }
  );

  it("keeps the full large Unicode memo while bounding structure independently", () => {
    const base = analysisNotification();
    const first = base.data.matches[0];
    if (!first) { throw new Error("Expected match fixture"); }
    const note = "界" + "x".repeat(RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES - 8_192);
    const input = { ...base, data: { ...base.data, matches: [{ ...first, note }] } };
    const value = parseNotificationJson(JSON.stringify(input));
    const parsed = validateStoredNotification(value);
    expect(parsed).toEqual(input);
    expect(() => validateNewNotification(value)).toThrow("payload_too_large");
  });

  it.each(["matches", "seasons"] as const)("stops validating %s after the first invalid item", field => {
    let inspected = 0;
    const tail = Object.defineProperty({}, field === "matches" ? "matchId" : "seasonId", {
      get: () => { inspected += 1; throw new Error("Tail must not be validated"); }
    });
    const base = analysisNotification();
    expect(() => validateNewNotification({ ...base, data: { ...base.data, [field]: [{}, tail] } })).toThrow("invalid_input");
    expect(inspected).toBe(0);
  });

  it("rejects invalid OCR failure collections without validating their tail", () => {
    let inspected = 0;
    const tail = Object.defineProperty({}, "screenType", { get: () => { inspected += 1; throw new Error("Unexpected access"); } });
    const base = ocrNotification();
    expect(() => validateNewNotification({ ...base, data: { ...base.data, failures: [{}, tail] } })).toThrow("invalid_input");
    expect(inspected).toBe(0);
  });

  it.each(["matches", "seasons"] as const)("preserves valid compact %s arrays approaching the existing JSONB byte ceiling", field => {
    const base = analysisNotification();
    const ranks = [1, 2, 3, 4].map(rank => ({ memberId: String(rank), displayName: "", before: null,
      after: { matchCount: 0, averageRank: null }, delta: null, comparison: "empty" }));
    const minimum = field === "matches" ? {
      matchId: "0", sourceRevision: "0", heldEventId: "0", heldDateIso: "2026-09-08", matchNoInEvent: 1,
      playedAt: "2026-09-08T00:00:00.000Z", mapName: "", seasonId: "0", seasonName: "", ownerName: "",
      players: [1, 2, 3, 4].map(rank => ({ memberId: String(rank), displayName: "", rank, ginjiCount: 0 })), ginjiTotal: 0, note: ""
    } : { seasonId: "0", seasonName: "", ranks };
    // Fixed schema keys dominate structure density. This uses minimally sized values and accounts for longer unique IDs.
    const itemBytes = Buffer.byteLength(JSON.stringify(minimum)) + 8;
    const count = Math.floor((RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES - 8_192) / itemBytes);
    const values = Array.from({ length: count }, (_, index) => ({ ...minimum, [field === "matches" ? "matchId" : "seasonId"]: String(index) }));
    const raw = JSON.stringify({ ...base, data: { ...base.data, [field]: values } });
    expect(Buffer.byteLength(raw)).toBeLessThan(RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES * 0.98);
    const value = parseNotificationJson(raw);
    const parsed = validateStoredNotification(value);
    if (parsed.kind !== "analysis_completed") { throw new Error("Expected analysis payload"); }
    expect(parsed.data[field]).toHaveLength(count);
    expect(() => validateNewNotification(value)).toThrow("payload_too_large");
  });
});
