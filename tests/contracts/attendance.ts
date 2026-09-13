import { describe, expect, it } from "vitest";
import type { AppPorts, EnqueueOutboxInput, ResponseRow, SessionRow } from "../../src/db/ports.ts";
import { makeResponse, makeSession } from "../testing/fixtures.ts";
import { fridayPostponeVoting, saturdayAsking } from "../testing/sessionScenario.ts";

export interface AttendanceHarness {
  ports: AppPorts;
  snapshot(): Promise<unknown>;
  intents(): Promise<readonly { sessionId: string | null; dedupeKey: string; aggregateRevision: number; ordinal: number; payload: unknown }[]>;
}
export type AttendanceSeed = { sessions?: readonly SessionRow[]; responses?: readonly ResponseRow[] };
export const attendanceMembers = ["m1", "m2", "m3", "m4"].map((id, i) => ({ id, userId: `user-${i}`, displayName: `Member ${i}` }));
export const attendanceNow = new Date("2026-04-24T12:00:00.000Z");
export const attendanceInput = {
  responseId: "response-new", sessionId: "session-1", memberId: "m1", sourceInteractionId: "200",
  now: attendanceNow, memberCountExpected: 4
};
export const saturdayInput = { id: "saturday", candidateDateIso: "2026-04-25", deadlineAt: new Date("2026-04-25T12:30:00.000Z") };
export const attendanceResponses = (choice: ResponseRow["choice"], ids = ["m1", "m2", "m3", "m4"]): ResponseRow[] =>
  ids.map((memberId, i) => makeResponse({ id: `response-${memberId}`, memberId, choice, sourceInteractionId: String(100 + i) }));
export const attendanceIntent = (sessionId: string, revision = 0, ordinal = 0): EnqueueOutboxInput => ({
  kind: "send_message", sessionId, dedupeKey: `fixture-${sessionId}-${revision}-${ordinal}`,
  aggregateRevision: revision, ordinal,
  payload: { kind: "send_message", channelId: "channel-1", renderer: "ask_body", target: "askMessageId" }
});

export const attendanceContract = (label: string, create: (seed?: AttendanceSeed) => Promise<AttendanceHarness>): void => {
  describe(`attendance sequential contract (${label})`, () => {
    it("repairs missing messages once at the current revision without changing the Session", async () => {
      const row = fridayPostponeVoting({ id: "session-1", revision: 4 });
      const h = await create({ sessions: [row] });
      const queued = await h.ports.sessionCommands.recoverMissingMessageIntents(row.id);
      expect(queued.map(intent => ({ key: intent.dedupeKey, revision: intent.aggregateRevision, ordinal: intent.ordinal })))
        .toStrictEqual([{ key: "ask-body-session-1", revision: 4, ordinal: 32_766 },
          { key: "postpone-vote-session-1", revision: 4, ordinal: 32_767 }]);
      expect(await h.ports.sessions.findSessionById(row.id)).toStrictEqual(row);
      const after = await h.snapshot();
      expect(await h.ports.sessionCommands.recoverMissingMessageIntents(row.id)).toStrictEqual([]);
      expect(await h.snapshot()).toStrictEqual(after);
    });

    it("rolls back the first recovery intent when the second ordinal conflicts", async () => {
      const row = fridayPostponeVoting({ id: "session-1", revision: 4 });
      const h = await create({ sessions: [row] });
      await h.ports.outbox.enqueue(attendanceIntent(row.id, 4, 32_767));
      const before = await h.snapshot();
      await expect(h.ports.sessionCommands.recoverMissingMessageIntents(row.id)).rejects.toThrow(/./);
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("does not repair closed, fully published or absent Sessions", async () => {
      const closed = { ...fridayPostponeVoting({ id: "closed" }), status: "SKIPPED" as const };
      const published = saturdayAsking({ id: "published", askMessageId: "ask-existing" });
      const h = await create({ sessions: [closed, published] });
      const before = await h.snapshot();
      for (const id of [closed.id, published.id, "absent"]) {
        expect(await h.ports.sessionCommands.recoverMissingMessageIntents(id)).toStrictEqual([]);
      }
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("creates a unique session, elects one canonical message and returns independent values", async () => {
      const h = await create(); const row = makeSession();
      const created = await h.ports.sessions.createAskSession(row);
      expect(created).toMatchObject({ id: row.id, status: "ASKING", revision: 0 });
      expect(await h.ports.sessions.createAskSession({ ...row, id: "duplicate" })).toBeUndefined();
      expect(await h.ports.sessions.backfillAskMessageId(row.id, "first")).toBe(true);
      expect(await h.ports.sessions.backfillAskMessageId(row.id, "second")).toBe(false);
      created!.deadlineAt.setTime(0);
      expect(await h.ports.sessions.findSessionById(row.id)).toMatchObject({ deadlineAt: row.deadlineAt, askMessageId: "first" });
    });

    it("rolls back session and all intents when the second ordered intent conflicts", async () => {
      const h = await create(); const row = makeSession(); const before = await h.snapshot();
      const first = attendanceIntent(row.id);
      await expect(h.ports.sessions.createAskSession({ ...row, outbox: [first, { ...first, dedupeKey: "different-key" }] })).rejects.toThrow(/./);
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("fences older interactions and preserves a pending fourth time response", async () => {
      const h = await create({ sessions: [makeSession()], responses: attendanceResponses("T2330", ["m2", "m3", "m4"]) });
      expect(await h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, choice: "T2200" }))
        .toMatchObject({ kind: "accepted_pending", session: { revision: 1, status: "ASKING" } });
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, choice: "ABSENT", sourceInteractionId: "199" }))
        .toMatchObject({ kind: "stale_interaction", response: { choice: "T2200", sourceInteractionId: "200" } });
      expect(await h.snapshot()).toStrictEqual(before);
      expect(await h.ports.responses.listResponses("session-1")).toHaveLength(4);
    });

    it("records ABSENT, final state and the two ordered notices", async () => {
      const h = await create({ sessions: [makeSession()] });
      expect(await h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, choice: "ABSENT" }))
        .toMatchObject({ kind: "transitioned", outcome: "cancelled", session: { status: "POSTPONE_VOTING", revision: 2, deadlineAt: new Date("2026-04-24T15:00:00Z") } });
      expect((await h.intents()).map(row => ({ revision: row.aggregateRevision, ordinal: row.ordinal, payload: row.payload })))
        .toStrictEqual([
          { revision: 2, ordinal: 0, payload: { kind: "send_message", channelId: "223456789012345678", renderer: "settle_notice", extra: { reason: "absent", forceSuppressMentions: true } } },
          { revision: 2, ordinal: 1, payload: { kind: "send_message", channelId: "223456789012345678", renderer: "postpone_vote", target: "postponeMessageId", extra: {} } }
        ]);
    });

    it("rolls back the response, revision, transition and first notice when the second notice fails", async () => {
      const h = await create({ sessions: [makeSession()] });
      await h.ports.outbox.enqueue(attendanceIntent("session-1", 2, 1));
      const before = await h.snapshot();
      await expect(h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, choice: "ABSENT" })).rejects.toThrow(/./);
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("decides exactly at the deadline using the latest time and records its announcement", async () => {
      const row = saturdayAsking({ id: "session-1" });
      const responses = attendanceResponses("T2300");
      const h = await create({ sessions: [row], responses }); const before = await h.snapshot();
      expect(await h.ports.sessionCommands.settleAskingDeadline({ ...attendanceInput, now: new Date(row.deadlineAt.getTime() - 1) }))
        .toMatchObject({ kind: "not_due" });
      expect(await h.snapshot()).toStrictEqual(before);
      expect(await h.ports.sessionCommands.settleAskingDeadline({ ...attendanceInput, now: row.deadlineAt }))
        .toMatchObject({ kind: "transitioned", outcome: "decided", session: { status: "DECIDED", revision: 1,
          decidedStartAt: new Date("2026-04-25T14:00:00Z"), reminderAt: new Date("2026-04-25T13:45:00Z") } });
      expect((await h.intents()).map(intent => intent.dedupeKey)).toStrictEqual(["decided-announcement-session-1"]);
    });

    it.each(["submit", "settle"] as const)("creates Saturday and its intent with the all-OK parent through %s", async mode => {
      const row = fridayPostponeVoting({ id: "session-1" });
      const responses = attendanceResponses("POSTPONE_OK", mode === "submit" ? ["m2", "m3", "m4"] : undefined);
      const h = await create({ sessions: [row], responses });
      const input = { ...attendanceInput, saturday: saturdayInput };
      const result = mode === "submit"
        ? await h.ports.sessionCommands.submitPostponeVote({ ...input, choice: "POSTPONE_OK" })
        : await h.ports.sessionCommands.settlePostponeVoting(input);
      expect(result).toMatchObject({ kind: "transitioned", outcome: "all_ok", session: { status: "POSTPONED", revision: 1 },
        saturdaySession: { id: "saturday", status: "ASKING", weekKey: "2026-W17", postponeCount: 1, deadlineAt: saturdayInput.deadlineAt } });
      expect(await h.ports.sessions.findSessionById("saturday")).toMatchObject({ status: "ASKING", revision: 0 });
      expect(await h.intents()).toStrictEqual([{ sessionId: "saturday", dedupeKey: "ask-body-saturday", aggregateRevision: 0, ordinal: 0,
        payload: { kind: "send_message", channelId: row.channelId, renderer: "ask_body", target: "askMessageId", extra: {} } }]);
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.settlePostponeVoting(input)).toMatchObject({ kind: "closed" });
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it.each(["ng", "unanswered"] as const)("terminates postponement for %s without creating Saturday", async reason => {
      const row = fridayPostponeVoting({ id: "session-1" }); const h = await create({ sessions: [row] });
      const input = { ...attendanceInput, saturday: saturdayInput };
      const result = reason === "ng" ? await h.ports.sessionCommands.submitPostponeVote({ ...input, choice: "POSTPONE_NG" })
        : await h.ports.sessionCommands.settlePostponeVoting({ ...input, now: row.deadlineAt });
      expect(result).toMatchObject({ kind: "transitioned", outcome: "cancelled", session: { status: "COMPLETED", revision: 1,
        cancelReason: reason === "ng" ? "postpone_ng" : "postpone_unanswered" } });
      expect(await h.ports.sessions.findSessionById("saturday")).toBeUndefined();
      expect(await h.intents()).toStrictEqual([]);
    });

    it("records held participants once and keeps the losing completion side-effect free", async () => {
      const row = makeSession({ status: "DECIDED", decidedStartAt: new Date("2026-04-24T14:00:00Z") });
      const h = await create({ sessions: [row] });
      const input = { sessionId: row.id, reminderSentAt: new Date("2026-04-24T13:45:00Z"), memberIds: ["m1", "m2"] };
      const result = await h.ports.heldEvents.completeDecidedSessionAsHeld(input);
      expect(result).toMatchObject({ session: { status: "COMPLETED", revision: 1, reminderSentAt: input.reminderSentAt },
        heldEvent: { sessionId: row.id, heldDateIso: row.candidateDateIso, startAt: row.decidedStartAt } });
      expect(result?.participants.map(participant => participant.memberId).sort()).toStrictEqual(["m1", "m2"]);
      const before = await h.snapshot();
      expect(await h.ports.heldEvents.completeDecidedSessionAsHeld({ ...input, memberIds: ["m3"] })).toBeUndefined();
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("recovers an existing Saturday and persists its missing intent", async () => {
      const parent = fridayPostponeVoting({ id: "session-1" });
      const child = saturdayAsking({ id: "existing-saturday" });
      const h = await create({ sessions: [parent, child], responses: attendanceResponses("POSTPONE_OK") });
      expect(await h.ports.sessionCommands.settlePostponeVoting({ ...attendanceInput, saturday: saturdayInput }))
        .toMatchObject({ kind: "transitioned", saturdaySession: { id: child.id } });
      expect((await h.intents()).map(intent => intent.dedupeKey)).toStrictEqual(["ask-body-existing-saturday"]);
    });

    it("rejects closed, missing-member and expired commands without changing state", async () => {
      const asking = makeSession(); const voting = fridayPostponeVoting({ id: "voting" });
      const h = await create({ sessions: [asking, { ...voting, weekKey: "2026-W18" }] });
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, memberId: "missing", choice: "T2200" })).toMatchObject({ kind: "member_not_found" });
      expect(await h.ports.sessionCommands.submitAskResponse({ ...attendanceInput, now: asking.deadlineAt, choice: "T2200" })).toMatchObject({ kind: "deadline_passed" });
      expect(await h.ports.sessionCommands.submitPostponeVote({ ...attendanceInput, choice: "POSTPONE_OK", saturday: saturdayInput })).toMatchObject({ kind: "closed" });
      expect(await h.ports.sessionCommands.submitPostponeVote({ ...attendanceInput, sessionId: voting.id, now: voting.deadlineAt, choice: "POSTPONE_OK", saturday: saturdayInput })).toMatchObject({ kind: "deadline_passed" });
      expect(await h.ports.sessionCommands.settlePostponeVoting({ ...attendanceInput, sessionId: voting.id, saturday: saturdayInput })).toMatchObject({ kind: "not_due" });
      expect(await h.ports.sessionCommands.settleAskingDeadline({ ...attendanceInput, sessionId: "missing" })).toStrictEqual({ kind: "session_not_found" });
      expect(await h.ports.sessionCommands.settleAskingCancellation({ sessionId: voting.id, now: attendanceNow, reason: "absent" })).toMatchObject({ kind: "closed" });
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("settles unanswered Saturday directly and makes repeated cancellation a no-op", async () => {
      const row = saturdayAsking({ id: "session-1" }); const h = await create({ sessions: [row] });
      const input = { sessionId: row.id, now: row.deadlineAt, reason: "deadline_unanswered" as const };
      expect(await h.ports.sessionCommands.settleAskingCancellation(input))
        .toMatchObject({ kind: "transitioned", session: { status: "COMPLETED", cancelReason: "saturday_cancelled" } });
      expect((await h.intents()).map(intent => intent.dedupeKey)).toStrictEqual(["settle-notice-session-1-saturday_cancelled"]);
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.settleAskingCancellation(input)).toMatchObject({ kind: "closed" });
      expect(await h.snapshot()).toStrictEqual(before);
    });
  });
};
