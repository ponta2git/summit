import { describe, expect, it } from "vitest";
import { prepareResultReceipt } from "../../src/db/repositories/resultNotifications.prepare.ts";
import { NotificationInputError } from "../../src/domain/notificationInput.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";

describe("receipt preparation without retained parsed bodies", () => {
  it("returns only original JSON, identity and the fields needed for inserts", () => {
    const payload = analysisNotification(); const rawJson = JSON.stringify(payload);
    expect(prepareResultReceipt(rawJson, () => undefined)).toEqual({
      rawJson,
      identity: { outcome: "ready", value: { notificationId: payload.notificationId, sourceJobId: payload.sourceJobId, kind: "analysis_completed" } },
      newAdmission: { outcome: "ready", value: {
        notificationId: payload.notificationId, sourceJobId: payload.sourceJobId, kind: "analysis_completed", schemaVersion: 1,
        occurredAt: new Date(payload.occurredAt), settingsGeneration: BigInt(payload.settingsGeneration),
        targetKind: "match", targetIds: ["match-1"]
      } }
    });
  });

  it.each([
    { raw: "{invalid", expected: { outcome: "expected", stage: "identity", code: "invalid_input" } },
    { raw: JSON.stringify({ ...analysisNotification(), schemaVersion: 9 }), expected: { outcome: "expected", stage: "identity", code: "unsupported_version" } }
  ])("records identity/version failure until the original DB stage", ({ raw, expected }) => {
    const result = prepareResultReceipt(raw, () => { throw new Error("must not run"); });
    expect(result).toEqual({ rawJson: raw, identity: expected, newAdmission: null });
  });

  it.each([
    { thrown: new NotificationInputError("payload_too_large"), expected: { outcome: "expected", stage: "admission", code: "payload_too_large" } },
    { thrown: new Error("private diagnostic", { cause: analysisNotification() }), expected: { outcome: "unexpected", stage: "admission" } }
  ])("keeps a fixed admission outcome without the exception or its cause", ({ thrown, expected }) => {
    const result = prepareResultReceipt(JSON.stringify(analysisNotification()), () => { throw thrown; });
    expect(result.identity.outcome).toBe("ready"); expect(result.newAdmission).toEqual(expected);
  });

  it("bounds insert metadata below 32 KiB even with fifty maximum-length Unicode targets", () => {
    const base = analysisNotification(); const match = base.data.matches[0];
    if (!match) { throw new Error("Expected analysis fixture"); }
    const payload = { ...base, data: { ...base.data, currentAnalysis: { ...base.data.currentAnalysis,
      algorithmVersion: "x".repeat(200_000) }, matches: Array.from({ length: 50 }, (_, index) => ({
      ...match, matchId: "界".repeat(196) + String(index).padStart(4, "0")
    })) } };
    const result = prepareResultReceipt(JSON.stringify(payload), () => undefined);
    expect(result.newAdmission?.outcome).toBe("ready");
    const projected = JSON.stringify(result.newAdmission, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    expect(projected).not.toContain(payload.data.currentAnalysis.algorithmVersion);
    expect(Buffer.byteLength(projected)).toBeLessThan(32 * 1024);
    expect(Buffer.byteLength(projected) * 4).toBeLessThan(128 * 1024);
  });
});
