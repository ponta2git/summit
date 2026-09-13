import { describe, expect, it, vi } from "vitest";
import { attendanceInput, attendanceIntent, attendanceMembers, attendanceNow, attendanceResponses, saturdayInput } from "../contracts/attendance.ts";
import { makeOutboxEntry, makeSession } from "./fixtures.ts";
import { fridayPostponeVoting } from "./sessionScenario.ts";
import { createTestAppContext } from "./ports.ts";

describe("fake aggregate rollback and snapshot isolation", () => {
  it("propagates asynchronous outbox failure and does not leave the newly created session", async () => {
    const { ports } = createTestAppContext();
    vi.spyOn(ports.outbox, "enqueue").mockRejectedValueOnce(new Error("intent unavailable"));
    await expect(ports.sessions.createAskSession({ ...makeSession(), outbox: [attendanceIntent("session-1")] })).rejects.toThrow("intent unavailable");
    expect(ports.sessions.listSessions()).toStrictEqual([]);
    expect(ports.outbox.listEntries()).toStrictEqual([]);
  });
  it("keeps an explicitly invalid DECIDED row unchanged when required startAt is missing", async () => {
    // invariant violation is deliberate: verify no transition survives validation failure.
    const invalid = makeSession({ status: "DECIDED", decidedStartAt: null });
    const { ports } = createTestAppContext({ seed: { sessions: [invalid] } });
    await expect(ports.heldEvents.completeDecidedSessionAsHeld({ sessionId: invalid.id, reminderSentAt: attendanceNow, memberIds: [] })).rejects.toThrow("decidedStartAt");
    expect(ports.sessions.listSessions()).toStrictEqual([invalid]);
    expect(ports.heldEvents.listHeldEvents()).toStrictEqual([]);
  });
  it("rolls back the response, parent and Saturday when its intent fails", async () => {
    const row = fridayPostponeVoting({ id: "session-1" }); const responses = attendanceResponses("POSTPONE_OK", ["m2", "m3", "m4"]);
    const { ports } = createTestAppContext({ seed: { sessions: [row], responses, members: attendanceMembers } });
    vi.spyOn(ports.outbox, "enqueue").mockRejectedValueOnce(new Error("intent unavailable"));
    await expect(ports.sessionCommands.submitPostponeVote({ ...attendanceInput, choice: "POSTPONE_OK", saturday: saturdayInput })).rejects.toThrow("intent unavailable");
    expect(ports.sessions.listSessions()).toStrictEqual([row]);
    expect(ports.responses.listAllResponses()).toStrictEqual(responses);
    expect(ports.outbox.listEntries()).toStrictEqual([]);
  });
  it("restores sending ownership as well as rows after cancel_week fails", async () => {
    const row = makeSession(); const { ports } = createTestAppContext({ now: attendanceNow, seed: { sessions: [row] } });
    await ports.outbox.enqueue(attendanceIntent(row.id));
    const [claim] = await ports.outbox.claimNextBatch({ limit: 1, now: attendanceNow, claimDurationMs: 60_000 });
    if (!claim?.claimToken) { throw new Error("Expected claim"); }
    const owner = { claimToken: claim.claimToken, now: attendanceNow };
    expect(await ports.outbox.beginDelivery(claim.id, owner)).toBe(true);
    const before = ports.outbox.listEntries();
    vi.spyOn(ports.outbox, "enqueue").mockRejectedValueOnce(new Error("notice unavailable"));
    await expect(ports.sessionCommands.cancelWeekAtomically({ ...row, sentinelSessionId: "sentinel", invokerUserId: "user-0", suppressMentions: true, now: attendanceNow })).rejects.toThrow("notice unavailable");
    expect(ports.sessions.listSessions()).toStrictEqual([row]);
    expect(ports.outbox.listEntries()).toStrictEqual(before);
    expect(await ports.outbox.markDelivered(claim.id, { ...owner, deliveredMessageId: "sent" })).toBe(true);
  });
  it("keeps seed, retrieved Date and nested payload values independent", async () => {
    const row = makeSession(); const intent = makeOutboxEntry();
    const { ports } = createTestAppContext({ seed: { sessions: [row], outbox: [intent] } });
    row.deadlineAt.setTime(0); intent.nextAttemptAt.setTime(0);
    const retrieved = (await ports.sessions.findSessionById(row.id))!;
    retrieved.deadlineAt.setTime(1);
    const entries = ports.outbox.listEntries();
    Object.assign(entries[0]!.payload, { channelId: "changed" });
    expect((await ports.sessions.findSessionById(row.id))!.deadlineAt).toStrictEqual(new Date("2026-04-24T12:30:00Z"));
    expect(ports.outbox.listEntries()[0]!.payload).toStrictEqual(makeOutboxEntry().payload);
    expect(ports.outbox.listEntries()[0]!.nextAttemptAt).toStrictEqual(makeOutboxEntry().nextAttemptAt);
  });
});
