import { describe, expect, it } from "vitest";

import {
  checkStrandedOutboxEntries,
  collectInvariantWarnings
} from "../../../src/features/status-command/invariantChecks.js";
import { makeOutboxEntry, makeSession } from "../../testing/fixtures.js";

const NOW = new Date("2026-04-25T12:30:00.000Z"); // 21:30 JST

describe("collectInvariantWarnings", () => {
  it("collects multiple warnings for a stranded session", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z"), // past
      askMessageId: null
    });
    const warnings = collectInvariantWarnings(session, NOW, undefined);
    expect(warnings.length).toBe(2);
    expect(warnings.map((w) => w.kind)).toContain("asking_past_deadline");
    expect(warnings.map((w) => w.kind)).toContain("asking_null_message_id");
  });

  it("returns empty array for a healthy ASKING session", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T13:00:00.000Z"), // future
      askMessageId: "msg-123"
    });
    expect(collectInvariantWarnings(session, NOW, undefined)).toHaveLength(0);
  });

  it("collects warnings for overdue postpone voting and stale reminder claims", () => {
    const postponeWarnings = collectInvariantWarnings(
      makeSession({
        status: "POSTPONE_VOTING",
        deadlineAt: new Date("2026-04-25T12:00:00.000Z")
      }),
      NOW,
      undefined
    );
    expect(postponeWarnings.map((warning) => warning.kind)).toContain(
      "postpone_voting_past_deadline"
    );

    const decidedWarnings = collectInvariantWarnings(
      makeSession({
        status: "DECIDED",
        reminderSentAt: new Date("2026-04-25T12:00:00.000Z")
      }),
      NOW,
      undefined
    );
    expect(decidedWarnings.map((warning) => warning.kind)).toContain(
      "decided_stale_reminder_claim"
    );
  });

  it("reports stranded outbox rows with the oldest dedupe key", () => {
    const warning = checkStrandedOutboxEntries([
      makeOutboxEntry({
        id: "outbox-new",
        dedupeKey: "newest",
        createdAt: new Date("2026-04-25T12:20:00.000Z")
      }),
      makeOutboxEntry({
        id: "outbox-old",
        dedupeKey: "oldest",
        createdAt: new Date("2026-04-25T12:10:00.000Z")
      })
    ]);

    expect(warning).toStrictEqual({
      kind: "outbox_stranded",
      message:
        '2 outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="oldest"'
    });
  });
});
