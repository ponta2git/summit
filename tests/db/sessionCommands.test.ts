import { describe, expect, it } from "vitest";

import type { MemberRow, ResponseRow } from "../../src/db/rows.js";
import { createTestAppContext, makeSession } from "../testing/index.js";

const members: readonly MemberRow[] = ["m1", "m2", "m3", "m4"].map(
  (id, index) => ({
    id,
    userId: `user-${index + 1}`,
    displayName: `Member ${index + 1}`
  })
);

const response = (
  memberId: string,
  choice: ResponseRow["choice"],
  sourceInteractionId: string
): ResponseRow => ({
  id: `response-${memberId}`,
  sessionId: "session-1",
  memberId,
  choice,
  answeredAt: new Date("2026-04-24T12:20:00.000Z"),
  sourceInteractionId
});

const askInput = {
  responseId: "response-new",
  sessionId: "session-1",
  memberId: "m1",
  choice: "T2200",
  sourceInteractionId: "200",
  now: new Date("2026-04-24T12:29:00.000Z"),
  memberCountExpected: 4
} as const;

describe("SessionCommandsPort", () => {
  it("rejects an older interaction without overwriting the newer response", async () => {
    const session = makeSession();
    const newer = response("m1", "T2330", "300");
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses: [newer], members }
    });

    const result = await ctx.ports.sessionCommands.submitAskResponse({
      ...askInput,
      sourceInteractionId: "200"
    });

    expect(result.kind).toBe("stale_interaction");
    expect(await ctx.ports.responses.listResponses(session.id)).toStrictEqual([newer]);
    expect((await ctx.ports.sessions.findSessionById(session.id))?.revision).toBe(0);
  });

  it("keeps a fourth time response pending before deadline and increments revision", async () => {
    const session = makeSession();
    const ctx = createTestAppContext({
      seed: {
        sessions: [session],
        members,
        responses: [
          response("m2", "T2230", "101"),
          response("m3", "T2300", "102"),
          response("m4", "T2330", "103")
        ]
      }
    });

    const result = await ctx.ports.sessionCommands.submitAskResponse(askInput);

    expect(result.kind).toBe("accepted_pending");
    expect((await ctx.ports.sessions.findSessionById(session.id))).toMatchObject({
      status: "ASKING",
      revision: 1
    });
    expect(await ctx.ports.responses.listResponses(session.id)).toHaveLength(4);
  });

  it("records ABSENT and atomically settles Friday into postpone voting", async () => {
    const session = makeSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members }
    });

    const result = await ctx.ports.sessionCommands.submitAskResponse({
      ...askInput,
      choice: "ABSENT"
    });

    expect(result).toMatchObject({
      kind: "transitioned",
      outcome: "cancelled",
      session: { status: "POSTPONE_VOTING", cancelReason: "absent", revision: 2 },
      response: {
        choice: "ABSENT",
        sourceInteractionId: askInput.sourceInteractionId
      }
    });
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      aggregateRevision: entry.aggregateRevision,
      ordinal: entry.ordinal
    }))).toStrictEqual([
      { renderer: "settle_notice", aggregateRevision: 2, ordinal: 0 },
      { renderer: "postpone_vote", aggregateRevision: 2, ordinal: 1 }
    ]);
  });

  it("settles all time responses exactly at deadline from one snapshot", async () => {
    const session = makeSession();
    const ctx = createTestAppContext({
      seed: {
        sessions: [session],
        members,
        responses: [
          response("m1", "T2200", "101"),
          response("m2", "T2230", "102"),
          response("m3", "T2300", "103"),
          response("m4", "T2330", "104")
        ]
      }
    });

    const result = await ctx.ports.sessionCommands.settleAskingDeadline({
      sessionId: session.id,
      now: session.deadlineAt,
      memberCountExpected: 4
    });

    expect(result).toMatchObject({
      kind: "transitioned",
      outcome: "decided",
      session: {
        status: "DECIDED",
        decidedStartAt: new Date("2026-04-24T14:30:00.000Z"),
        reminderAt: new Date("2026-04-24T14:15:00.000Z"),
        revision: 1
      }
    });
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.dedupeKey)).toStrictEqual([
      `decided-announcement-${session.id}`
    ]);
  });

  it("creates Saturday ASKING with the POSTPONED parent in the all-OK command", async () => {
    const session = makeSession({
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    const ctx = createTestAppContext({
      seed: {
        sessions: [session],
        members,
        responses: [
          response("m2", "POSTPONE_OK", "101"),
          response("m3", "POSTPONE_OK", "102"),
          response("m4", "POSTPONE_OK", "103")
        ]
      }
    });

    const result = await ctx.ports.sessionCommands.submitPostponeVote({
      ...askInput,
      choice: "POSTPONE_OK",
      now: new Date("2026-04-24T14:59:00.000Z"),
      saturday: {
        id: "session-saturday",
        candidateDateIso: "2026-04-25",
        deadlineAt: new Date("2026-04-25T12:30:00.000Z")
      }
    });

    expect(result).toMatchObject({
      kind: "transitioned",
      outcome: "all_ok",
      session: { status: "POSTPONED", revision: 1 },
      saturdaySession: {
        id: "session-saturday",
        status: "ASKING",
        postponeCount: 1,
        weekKey: session.weekKey
      }
    });
    expect(ctx.ports.sessions.listSessions()).toHaveLength(2);
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      sessionId: entry.sessionId,
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      aggregateRevision: entry.aggregateRevision
    }))).toStrictEqual([{
      sessionId: "session-saturday",
      renderer: "ask_body",
      aggregateRevision: 0
    }]);
  });
});
