import { describe, expect, it } from "vitest";

import {
  checkStrandedCancelledSessions,
  checkStrandedOutboxEntries,
  collectInvariantWarnings
} from "../../../src/features/status-command/invariantChecks.js";
import { makeOutboxEntry, makeSession } from "../../testing/fixtures.js";

const NOW = new Date("2026-04-25T12:30:00.000Z"); // 21:30 JST

describe("collectInvariantWarnings", () => {
  it("returns every ASKING warning at the exact deadline boundary", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: NOW,
      askMessageId: null
    });

    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([
      {
        kind: "asking_past_deadline",
        message: "ASKING session session- has passed deadline but is not yet settled."
      },
      {
        kind: "asking_null_message_id",
        message:
          "ASKING session session- has no askMessageId (Discord send may have failed)."
      }
    ]);
  });

  it.each([
    {
      label: "deadline is still in the future",
      session: makeSession({
        status: "ASKING",
        deadlineAt: new Date(NOW.getTime() + 1),
        askMessageId: "msg-123"
      })
    },
    {
      label: "session is no longer ASKING",
      session: makeSession({
        status: "COMPLETED",
        deadlineAt: new Date(NOW.getTime() - 1),
        askMessageId: null
      })
    }
  ])("does not report ASKING warnings when $label", ({ session }) => {
    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([]);
  });

  it("reports an overdue postpone vote at the exact deadline boundary", () => {
    const session = makeSession({ status: "POSTPONE_VOTING", deadlineAt: NOW });

    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([
      {
        kind: "postpone_voting_past_deadline",
        message:
          "POSTPONE_VOTING session session- has passed deadline but is not yet settled."
      }
    ]);
  });

  it.each([
    {
      label: "deadline is still in the future",
      session: makeSession({
        status: "POSTPONE_VOTING",
        deadlineAt: new Date(NOW.getTime() + 1)
      })
    },
    {
      label: "session is not in postpone voting",
      session: makeSession({ status: "COMPLETED", deadlineAt: NOW })
    }
  ])("does not report postpone warnings when $label", ({ session }) => {
    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([]);
  });

  it("reports a DECIDED session carrying a completion-only reminder marker", () => {
    const session = makeSession({ status: "DECIDED", reminderSentAt: NOW });

    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([
      {
        kind: "decided_reminder_completion_mismatch",
        message:
          "DECIDED session session- has reminderSentAt set before completion."
      }
    ]);
  });

  it.each([
    {
      label: "the reminder has not completed",
      session: makeSession({ status: "DECIDED", reminderSentAt: null }),
    },
    {
      label: "the session is not DECIDED",
      session: makeSession({ status: "COMPLETED", reminderSentAt: NOW }),
    }
  ])("does not report a reminder completion mismatch when $label", ({ session }) => {
    expect(collectInvariantWarnings(session, NOW)).toStrictEqual([]);
  });
});

describe("aggregate invariant checks", () => {
  it("reports every stranded CANCELLED session in input order", () => {
    expect(
      checkStrandedCancelledSessions([
        makeSession({ id: "old-cancelled", status: "CANCELLED" }),
        makeSession({ id: "new-cancelled", status: "CANCELLED" })
      ])
    ).toStrictEqual({
      kind: "stranded_cancelled",
      message:
        "2 session(s) stuck in CANCELLED (reconciler may not have run): [old-canc, new-canc]"
    });
  });

  it("does not report stranded CANCELLED sessions when none exist", () => {
    expect(checkStrandedCancelledSessions([])).toBeUndefined();
  });

  it("reports stranded outbox rows with the oldest dedupe key", () => {
    expect(
      checkStrandedOutboxEntries([
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
      ])
    ).toStrictEqual({
      kind: "outbox_stranded",
      message:
        '2 outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="oldest"'
    });
  });

  it("does not report stranded outbox rows when none exist", () => {
    expect(checkStrandedOutboxEntries([])).toBeUndefined();
  });
});
