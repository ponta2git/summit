import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cancelAsking,
  claimReminderDispatch,
  completeCancelledSession,
  completePostponeVoting,
  completeSession,
  createAskSession,
  decideAsking,
  findSessionById,
  revertReminderClaim,
  startPostponeVoting
} from "../../src/db/repositories/sessions.js";
import type { SessionRow } from "../../src/db/rows.js";
import { baseSession, createSessionsContractHarness } from "./_sessionsContract.js";
import { isIntegration } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

const singleWinner = (results: readonly (SessionRow | undefined)[]): SessionRow => {
  const winners = results.filter((row): row is SessionRow => row !== undefined);
  expect(winners).toHaveLength(1);
  return winners[0]!;
};

describeDb("sessions repository race contract (integration)", () => {
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

  it("allows exactly one concurrent ASKING cancellation", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const winner = singleWinner(await Promise.all([
      cancelAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.000Z"),
        reason: "deadline_unanswered"
      }),
      cancelAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.001Z"),
        reason: "deadline_unanswered"
      })
    ]));

    expect(winner.status).toBe("CANCELLED");
    expect((await findSessionById(db, "s1"))?.status).toBe(winner.status);
  });

  it("allows exactly one concurrent startPostponeVoting transition", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    const deadlineAt = new Date("2026-04-24T15:00:00.000Z");
    const winner = singleWinner(await Promise.all([
      startPostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.000Z"),
        postponeDeadlineAt: deadlineAt
      }),
      startPostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.001Z"),
        postponeDeadlineAt: deadlineAt
      })
    ]));

    const persisted = await findSessionById(db, "s1");
    expect({ status: winner.status, persistedStatus: persisted?.status, deadlineAt: persisted?.deadlineAt })
      .toStrictEqual({
        status: "POSTPONE_VOTING",
        persistedStatus: "POSTPONE_VOTING",
        deadlineAt
      });
  });

  it("allows exactly one conflicting postpone-vote outcome", async () => {
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
    const winner = singleWinner(await Promise.all([
      completePostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T15:00:01.000Z"),
        outcome: "decided"
      }),
      completePostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T15:00:01.001Z"),
        outcome: "cancelled_full",
        cancelReason: "postpone_unanswered"
      })
    ]));

    const persisted = await findSessionById(db, "s1");
    expect({ status: persisted?.status, cancelReason: persisted?.cancelReason }).toStrictEqual({
      status: winner.status,
      cancelReason: winner.cancelReason
    });
  });

  it("allows exactly one concurrent ASKING decision and persists its timestamps", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const winner = singleWinner(await Promise.all([
      decideAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.000Z"),
        decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
        reminderAt: new Date("2026-04-24T13:45:00.000Z")
      }),
      decideAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.001Z"),
        decidedStartAt: new Date("2026-04-24T14:30:00.000Z"),
        reminderAt: new Date("2026-04-24T14:15:00.000Z")
      })
    ]));

    const persisted = await findSessionById(db, "s1");
    expect({
      status: persisted?.status,
      decidedStartAt: persisted?.decidedStartAt,
      reminderAt: persisted?.reminderAt
    }).toStrictEqual({
      status: "DECIDED",
      decidedStartAt: winner.decidedStartAt,
      reminderAt: winner.reminderAt
    });
  });

  it("allows exactly one concurrent CANCELLED completion", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "saturday_cancelled"
    });
    const winner = singleWinner(await Promise.all([
      completeCancelledSession(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.000Z")
      }),
      completeCancelledSession(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.001Z")
      })
    ]));

    expect(winner.status).toBe("COMPLETED");
    expect((await findSessionById(db, "s1"))?.status).toBe("COMPLETED");
  });

  it("allows exactly one concurrent reminder claim", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    const winner = singleWinner(await Promise.all([
      claimReminderDispatch(db, "s1", new Date("2026-04-24T13:45:00.000Z")),
      claimReminderDispatch(db, "s1", new Date("2026-04-24T13:45:00.001Z"))
    ]));

    expect((await findSessionById(db, "s1"))?.reminderSentAt)
      .toStrictEqual(winner.reminderSentAt);
  });

  it("reverts only the live matching reminder claim", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    const claimedAt = new Date("2026-04-24T13:45:00.000Z");
    await claimReminderDispatch(db, "s1", claimedAt);

    expect(await revertReminderClaim(
      db,
      "s1",
      new Date("2026-04-24T13:46:00.000Z")
    )).toBe(false);
    expect(await revertReminderClaim(db, "s1", claimedAt)).toBe(true);

    const reclaimedAt = new Date("2026-04-24T13:47:00.000Z");
    expect((await claimReminderDispatch(db, "s1", reclaimedAt))?.reminderSentAt)
      .toStrictEqual(reclaimedAt);
    await completeSession(db, {
      id: "s1",
      now: new Date("2026-04-24T13:48:00.000Z"),
      reminderSentAt: reclaimedAt
    });

    expect(await revertReminderClaim(db, "s1", reclaimedAt)).toBe(false);
    const persisted = await findSessionById(db, "s1");
    expect({ status: persisted?.status, reminderSentAt: persisted?.reminderSentAt })
      .toStrictEqual({ status: "COMPLETED", reminderSentAt: reclaimedAt });
  });
});
