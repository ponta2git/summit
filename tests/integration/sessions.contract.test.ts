import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cancelAsking,
  completePostponeVoting,
  createAskSession,
  decideAsking,
  findSessionByWeekKeyAndPostponeCount,
  startPostponeVoting
} from "../../src/db/repositories/sessions.js";
import { listResponses, upsertResponse } from "../../src/db/repositories/responses.js";
import { baseSession, createSessionsContractHarness } from "./_sessionsContract.js";
import { isIntegration } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("sessions repository contract (integration)", () => {
  const harness = createSessionsContractHarness();
  const { db } = harness;

  beforeAll(async () => {
    await harness.initialize();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("createAskSession deduplicates (weekKey, postponeCount)", async () => {
    const first = await createAskSession(db, { id: "s1", ...baseSession });
    const second = await createAskSession(db, { id: "s2", ...baseSession });
    const persisted = await findSessionByWeekKeyAndPostponeCount(db, baseSession.weekKey, 0);

    expect({ firstId: first?.id, second, persistedId: persisted?.id }).toStrictEqual({
      firstId: "s1",
      second: undefined,
      persistedId: "s1"
    });
  });

  it("cancelAsking transitions ASKING to CANCELLED with its reason", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });

    const updated = await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });

    expect({ status: updated?.status, cancelReason: updated?.cancelReason }).toStrictEqual({
      status: "CANCELLED",
      cancelReason: "deadline_unanswered"
    });
  });

  it("cancelAsking returns undefined after the ASKING CAS has been consumed", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });

    expect(await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      reason: "deadline_unanswered"
    })).toBeUndefined();
  });

  it("startPostponeVoting updates status and deadline on a CAS win", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });

    const updated = await startPostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });

    expect({ status: updated?.status, deadlineAt: updated?.deadlineAt }).toStrictEqual({
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
  });

  it("completePostponeVoting stores a full-cancellation reason", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    await startPostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });

    const completed = await completePostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T15:00:01.000Z"),
      outcome: "cancelled_full",
      cancelReason: "postpone_unanswered"
    });

    expect({ status: completed?.status, cancelReason: completed?.cancelReason }).toStrictEqual({
      status: "COMPLETED",
      cancelReason: "postpone_unanswered"
    });
  });

  it("decideAsking persists the decided and reminder timestamps", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const decidedStartAt = new Date("2026-04-24T14:00:00.000Z");
    const reminderAt = new Date("2026-04-24T13:45:00.000Z");

    const decided = await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt,
      reminderAt
    });

    expect({
      status: decided?.status,
      decidedStartAt: decided?.decidedStartAt,
      reminderAt: decided?.reminderAt
    }).toStrictEqual({ status: "DECIDED", decidedStartAt, reminderAt });
  });

  it("upsertResponse keeps one row with the latest answer", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await upsertResponse(db, {
      id: "r1",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T10:00:00.000Z")
    });
    const latestAt = new Date("2026-04-24T10:05:00.000Z");
    await upsertResponse(db, {
      id: "r2",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2330",
      answeredAt: latestAt
    });

    expect((await listResponses(db, "s1")).map((row) => ({
      sessionId: row.sessionId,
      memberId: row.memberId,
      choice: row.choice,
      answeredAt: row.answeredAt
    }))).toStrictEqual([{
      sessionId: "s1",
      memberId: "m1",
      choice: "T2330",
      answeredAt: latestAt
    }]);
  });

  it("rejects postponeCount outside the database CHECK constraint", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO sessions
          (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
        VALUES
          ('s-bad', '2026-W17', 2, '2026-04-24', 'ASKING', 'c1', now())
      `);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const causeMessage = String(
      (caught as { cause?: { constraint_name?: string; message?: string } }).cause
        ?.constraint_name ??
        (caught as { cause?: { message?: string } }).cause?.message ??
        (caught as Error).message
    );
    expect(causeMessage).toContain("sessions_postpone_count_check");
    expect(await db.execute(sql`SELECT id FROM sessions WHERE id = 's-bad'`)).toHaveLength(0);
  });
});
