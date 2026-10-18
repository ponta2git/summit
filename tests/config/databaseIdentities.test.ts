import { describe, expect, it } from "vitest";
import { detectIdentityLayout, type IdentityColumn } from "../../src/db/identities.ts";

const entityNames = [
  "game_titles", "held_events", "incident_masters", "map_masters", "match_drafts", "matches",
  "member_aliases", "members", "momo_login_accounts", "ocr_drafts", "ocr_jobs", "ocr_submissions",
  "responses", "season_masters", "series_analysis_campaigns", "series_analysis_job_attempts",
  "series_analysis_job_requests", "series_analysis_jobs", "series_analysis_operation_requests",
  "series_radar_candidates", "series_radar_operations", "series_radar_previews", "sessions", "source_images"
];
const column = (table_name: string, column_name: string, udt_name: string, is_nullable = "NO"): IdentityColumn =>
  ({ table_name, column_name, udt_name, is_nullable });
const fixture = (canonical: boolean): IdentityColumn[] => {
  const type = canonical ? "uuid" : "text";
  return [
    ...entityNames.flatMap(name => [column(name, "id", type), ...(canonical ? [column(name, "legacy_id", "text")] : [])]),
    column("responses", "session_id", type), column("responses", "member_id", type),
    column("held_events", "session_id", type, "YES"), column("held_event_participants", "held_event_id", type),
    column("held_event_participants", "member_id", type), column("discord_notification_attendance", "session_id", "text", "YES"),
    column("idempotency_keys", "key", type),
    ...(canonical ? [column("idempotency_keys_legacy", "key", "text"),
      ...["series_analysis_artifact_identities", "series_radar_basis_identities"].flatMap(name => [
        column(name, "id", "uuid"), column(name, "legacy_id", "text"),
        column(name, "game_title_id", "uuid"), column(name, "legacy_game_title_id", "text")
      ])] : [])
  ];
};

describe("database identity layout admission", () => {
  it("accepts complete legacy and canonical schemas without converting notification identity", () => {
    expect(detectIdentityLayout(fixture(false))).toBe("legacy_text");
    expect(detectIdentityLayout(fixture(true))).toBe("canonical_uuid");
  });

  it.each([false, true])("rejects every missing contract column (canonical=%s)", canonical => {
    const rows = fixture(canonical);
    for (let index = 0; index < rows.length; index += 1) {
      expect(() => detectIdentityLayout(rows.filter((_, candidate) => candidate !== index))).toThrow("identity layout");
    }
  });

  it("rejects mixed UUID/text, nullable aliases and an expanded but uncontracted schema", () => {
    for (const actual of [
      fixture(true).map(row => row.table_name === "responses" && row.column_name === "session_id" ? { ...row, udt_name: "text" } : row),
      fixture(true).map(row => row.column_name === "legacy_id" ? { ...row, is_nullable: "YES" } : row),
      [...fixture(false), column("members", "canonical_id", "uuid", "YES")],
      [...fixture(true), column("members", "canonical_id", "uuid", "YES")],
      fixture(true).map(row => row.table_name === "discord_notification_attendance" ? { ...row, udt_name: "uuid" } : row)
    ]) {
      expect(() => detectIdentityLayout(actual)).toThrow("identity layout");
    }
  });
});
