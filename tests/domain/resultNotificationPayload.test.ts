import { readFileSync } from "node:fs";
import type { AnalysisCompletedNotification } from "@momo/db/notifications";
import { describe, expect, it } from "vitest";
import { validateNewNotification, validateStoredNotification } from "../../src/domain/resultNotificationPayload.ts";
import { analysisNotification, ocrNotification } from "../features/result-notifications/fixtures.ts";

describe("result notification payload OCR v2 and analysis v1", () => {
  it("accepts the actual Rust producer encoder fixture", () => {
    const wire: unknown = JSON.parse(readFileSync(new URL("../../../momo-db/docs/examples/ocr-completed-v2.json", import.meta.url), "utf8"));
    expect(validateNewNotification(wire)).toStrictEqual(wire);
  });

  it("preserves bigint decimal strings, notes and unrounded deltas", () => {
    expect(validateNewNotification(ocrNotification())).toEqual(ocrNotification());
    expect(validateNewNotification(analysisNotification())).toEqual(analysisNotification());
  });

  it("accepts no failures and rejects unsafe or duplicate submission members", () => {
    const payload = ocrNotification();
    expect(validateNewNotification(payload)).toStrictEqual(payload);
    expect(validateNewNotification({ ...payload, data: { ...payload.data, context: { ...payload.data.context, gameTitleName: "😀".repeat(201) } } })).toMatchObject({ data: { context: { gameTitleName: "😀".repeat(201) } } });
    for (const data of [
      { ...payload.data, submissionId: "not-a-submission" },
      { ...payload.data, matchDraftId: "../draft" },
      { ...payload.data, context: { ...payload.data.context, gameTitleName: "a".repeat(202) } },
      { ...payload.data, failures: [{ screenType: "total_assets", reason: "raw_exception" }] },
      { ...payload.data, failures: Array.from({ length: 2 }, () => ({ screenType: "total_assets", reason: "ocr_failed" })) },
      { ...payload.data, summary: "Retired field" }
    ]) { expect(() => validateNewNotification({ ...payload, data })).toThrow("invalid_input"); }
    expect(() => validateNewNotification({ ...payload, sourceJobId: "submission:22222222-2222-4222-8222-222222222222" }))
      .toThrow("invalid_input");
    expect(() => validateNewNotification({ ...payload, schemaVersion: 1 })).toThrow("unsupported_version");
    expect(() => validateNewNotification({ ...analysisNotification(), schemaVersion: 2 })).toThrow("unsupported_version");
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

  it("identifies reused results independently of the new logical job", () => {
    const original = analysisNotification();
    const reused = { ...original, data: {
      ...original.data, disposition: "reused", previousAnalysis: original.data.currentAnalysis,
      matches: [], overall: original.data.overall.map(rank => ({
        ...rank, before: rank.after, delta: 0, comparison: "reused"
      })), seasons: []
    } };
    expect(validateNewNotification(reused)).toEqual(reused);
    expect(() => validateNewNotification({ ...original, data: {
      ...original.data, currentAnalysis: { ...original.data.currentAnalysis, artifactId: undefined }
    } })).toThrow("invalid_input");
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

const fields: readonly {
  readonly name: string;
  readonly limit: number;
  readonly update: (input: AnalysisCompletedNotification, value: string) => unknown;
}[] = [
  { name: "game title", limit: 256, update: (input, value) => ({ ...input, data: { ...input.data, gameTitleName: value } }) },
  { name: "map", limit: 256, update: (input, value) => ({ ...input, data: { ...input.data, matches: input.data.matches.map(match => ({ ...match, mapName: value })) } }) },
  { name: "match season", limit: 256, update: (input, value) => ({ ...input, data: { ...input.data, matches: input.data.matches.map(match => ({ ...match, seasonName: value })) } }) },
  { name: "aggregate season", limit: 256, update: (input, value) => ({ ...input, data: { ...input.data, seasons: input.data.seasons.map(season => ({ ...season, seasonName: value })) } }) },
  { name: "owner", limit: 32, update: (input, value) => ({ ...input, data: { ...input.data, matches: input.data.matches.map(match => ({ ...match, ownerName: value })) } }) },
  { name: "match member", limit: 32, update: (input, value) => ({ ...input, data: { ...input.data, matches: input.data.matches.map(match => ({ ...match, players: match.players.map(player => ({ ...player, displayName: value })) })) } }) },
  { name: "overall member", limit: 32, update: (input, value) => ({ ...input, data: { ...input.data, overall: input.data.overall.map(rank => ({ ...rank, displayName: value })) } }) },
  { name: "season member", limit: 32, update: (input, value) => ({ ...input, data: { ...input.data, seasons: input.data.seasons.map(season => ({ ...season, ranks: season.ranks.map(rank => ({ ...rank, displayName: value })) })) } }) },
  { name: "memo", limit: 150, update: (input, value) => ({ ...input, data: { ...input.data, matches: input.data.matches.map(match => ({ ...match, note: value })) } }) }
];

describe("new admission and retained payload limits", () => {
  it.each(fields)("limits $name by Unicode code points while preserving retained data", ({ limit, update }) => {
    const input = analysisNotification();
    const accepted = update(input, "😀".repeat(limit));
    const oversized = update(input, "😀".repeat(limit + 1));
    expect(validateNewNotification(accepted)).toStrictEqual(accepted);
    expect(() => validateNewNotification(oversized)).toThrow("payload_too_large");
    expect(validateStoredNotification(oversized)).toStrictEqual(oversized);
  });

  it("accepts 50 changed matches and 16 affected seasons, rejects the next, and retains older counts", () => {
    const input = analysisNotification();
    const match = input.data.matches[0];
    const season = input.data.seasons[0];
    if (!match || !season) { throw new Error("Fixture requires one match and season."); }
    const atLimit = { ...input, data: { ...input.data,
      matches: Array.from({ length: 50 }, (_, index) => ({ ...match, matchId: `match-${index}` })),
      seasons: Array.from({ length: 16 }, (_, index) => ({ ...season, seasonId: `season-${index}` }))
    } };
    expect(validateNewNotification(atLimit)).toStrictEqual(atLimit);
    for (const oversized of [
      { ...atLimit, data: { ...atLimit.data, matches: [...atLimit.data.matches, { ...match, matchId: "match-51" }] } },
      { ...atLimit, data: { ...atLimit.data, seasons: [...atLimit.data.seasons, { ...season, seasonId: "season-17" }] } }
    ]) {
      expect(() => validateNewNotification(oversized)).toThrow("payload_too_large");
      expect(validateStoredNotification(oversized)).toStrictEqual(oversized);
    }
  });

  it("rejects oversized collections before validating each malformed member", () => {
    const input = analysisNotification();
    expect(() => validateNewNotification({ ...input, data: { ...input.data, matches: Array(51).fill(null) } }))
      .toThrow("payload_too_large");
    expect(() => validateNewNotification({ ...input, data: { ...input.data, matches: [null] } })).toThrow("invalid_input");
  });

  it("keeps structural errors distinct from capacity rejection", () => {
    const input = analysisNotification();
    expect(() => validateNewNotification({ ...input, data: { ...input.data, gameTitleName: 257 } })).toThrow("invalid_input");
    expect(() => validateStoredNotification({ ...input, schemaVersion: 2 })).toThrow("unsupported_version");
  });
});
