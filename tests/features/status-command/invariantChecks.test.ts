import { describe, expect, it } from "vitest";

import {
  checkAskingWithNullMessageId,
  checkAskingWithPastDeadline,
  checkDecidedStaleReminderClaim,
  checkPostponeVotingWithPastDeadline,
  collectInvariantWarnings
} from "../../../src/features/status-command/invariantChecks.js";
import type { HeldEventRow, SessionRow } from "../../../src/db/ports.js";
import { makeSession } from "../../testing/fixtures.js";

const NOW = new Date("2026-04-25T12:30:00.000Z"); // 21:30 JST

const fakeHeldEvent = (sessionId: string): HeldEventRow => ({
  id: "held-1",
  sessionId,
  heldDateIso: "2026-04-25",
  startAt: new Date("2026-04-25T13:00:00.000Z"),
  createdAt: new Date("2026-04-25T13:00:00.000Z")
});

describe("checkAskingWithPastDeadline", () => {
  it("returns warning when ASKING session has deadline in the past", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z") // past
    });
    const result = checkAskingWithPastDeadline(session, NOW);
    expect(result).not.toBeUndefined();
    expect(result?.kind).toBe("asking_past_deadline");
  });

  it("returns undefined when deadline is in the future", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T13:00:00.000Z") // future
    });
    expect(checkAskingWithPastDeadline(session, NOW)).toBeUndefined();
  });

  it("returns undefined for non-ASKING sessions", () => {
    const session = makeSession({
      status: "DECIDED",
      deadlineAt: new Date("2026-04-24T12:00:00.000Z")
    });
    expect(checkAskingWithPastDeadline(session, NOW)).toBeUndefined();
  });
});

describe("checkAskingWithNullMessageId", () => {
  it("returns warning when ASKING session has null askMessageId", () => {
    const session = makeSession({ status: "ASKING", askMessageId: null });
    const result = checkAskingWithNullMessageId(session);
    expect(result).not.toBeUndefined();
    expect(result?.kind).toBe("asking_null_message_id");
  });

  it("returns undefined when ASKING session has askMessageId set", () => {
    const session = makeSession({ status: "ASKING", askMessageId: "msg-123" });
    expect(checkAskingWithNullMessageId(session)).toBeUndefined();
  });

  it("returns undefined for non-ASKING sessions regardless of messageId", () => {
    const session = makeSession({ status: "DECIDED", askMessageId: null });
    expect(checkAskingWithNullMessageId(session)).toBeUndefined();
  });
});

describe("checkDecidedStaleReminderClaim", () => {
  it("returns warning when DECIDED session has reminderSentAt but no HeldEvent", () => {
    const session = makeSession({
      status: "DECIDED",
      reminderSentAt: new Date("2026-04-25T12:00:00.000Z")
    } as Partial<SessionRow>);
    const result = checkDecidedStaleReminderClaim(session, undefined);
    expect(result).not.toBeUndefined();
    expect(result?.kind).toBe("decided_stale_reminder_claim");
  });

  it("returns undefined when HeldEvent exists alongside reminderSentAt", () => {
    const session = makeSession({
      status: "DECIDED",
      reminderSentAt: new Date("2026-04-25T12:00:00.000Z")
    } as Partial<SessionRow>);
    const he = fakeHeldEvent(session.id);
    expect(checkDecidedStaleReminderClaim(session, he)).toBeUndefined();
  });

  it("returns undefined when reminderSentAt is null", () => {
    const session = makeSession({ status: "DECIDED", reminderSentAt: null } as Partial<SessionRow>);
    expect(checkDecidedStaleReminderClaim(session, undefined)).toBeUndefined();
  });

  it("returns undefined for non-DECIDED sessions", () => {
    const session = makeSession({
      status: "ASKING",
      reminderSentAt: new Date("2026-04-25T12:00:00.000Z")
    } as Partial<SessionRow>);
    expect(checkDecidedStaleReminderClaim(session, undefined)).toBeUndefined();
  });
});

describe("checkPostponeVotingWithPastDeadline", () => {
  it("returns warning for POSTPONE_VOTING with past deadline", () => {
    const session = makeSession({
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z")
    });
    const result = checkPostponeVotingWithPastDeadline(session, NOW);
    expect(result).not.toBeUndefined();
    expect(result?.kind).toBe("postpone_voting_past_deadline");
  });

  it("returns undefined for non-POSTPONE_VOTING sessions", () => {
    const session = makeSession({ status: "ASKING", deadlineAt: new Date("2026-04-25T12:00:00.000Z") });
    expect(checkPostponeVotingWithPastDeadline(session, NOW)).toBeUndefined();
  });
});

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
});
