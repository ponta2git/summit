import { describe, expect, it } from "vitest";
import { attendanceInput, attendanceIntent, attendanceResponses, saturdayInput } from "../contracts/attendance.ts";
import { makeSession } from "../testing/fixtures.ts";
import { fridayPostponeVoting } from "../testing/sessionScenario.ts";
import { createAttendanceHarness } from "./_attendance.ts";

const { create } = createAttendanceHarness();
describe("attendance transaction failure boundaries", () => {
  it("rolls back Session and HeldEvent if inserting a participant violates its member FK", async () => {
    const h = await create({ sessions: [makeSession({ status: "DECIDED", decidedStartAt: new Date("2026-04-24T14:00:00Z") })] });
    const before = await h.snapshot();
    await expect(h.ports.heldEvents.completeDecidedSessionAsHeld({ sessionId: "session-1", reminderSentAt: new Date("2026-04-24T13:45:00Z"), memberIds: ["m1", "missing"] }))
      .rejects.toMatchObject({ cause: { code: "23503" } });
    expect(await h.snapshot()).toStrictEqual(before);
  });

  it.each(["cancellation", "deadline"] as const)("rolls back %s and its notice on attendance order conflict", async command => {
    const row = makeSession();
    const h = await create({ sessions: [row], responses: command === "deadline" ? attendanceResponses("T2300") : [] });
    await h.ports.outbox.enqueue(attendanceIntent(row.id, command === "deadline" ? 1 : 2));
    const before = await h.snapshot();
    const result = command === "deadline"
      ? h.ports.sessionCommands.settleAskingDeadline({ ...attendanceInput, now: row.deadlineAt })
      : h.ports.sessionCommands.settleAskingCancellation({ sessionId: row.id, reason: "absent", now: attendanceInput.now });
    await expect(result).rejects.toMatchObject({ cause: { code: "23505", constraint_name: "discord_notification_attendance_order_unique" } });
    expect(await h.snapshot()).toStrictEqual(before);
  });

  it.each(["submit", "settle"] as const)("rolls back %s postponement when the Saturday primary key belongs to a different week", async command => {
    const row = fridayPostponeVoting({ id: "session-1" });
    const unrelated = makeSession({ id: saturdayInput.id, weekKey: "2026-W18", candidateDateIso: "2026-05-01" });
    const h = await create({ sessions: [row, unrelated], responses: attendanceResponses("POSTPONE_OK", command === "submit" ? ["m2", "m3", "m4"] : undefined) });
    const before = await h.snapshot(); const input = { ...attendanceInput, saturday: saturdayInput };
    const result = command === "submit" ? h.ports.sessionCommands.submitPostponeVote({ ...input, choice: "POSTPONE_OK" }) : h.ports.sessionCommands.settlePostponeVoting(input);
    await expect(result).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await h.snapshot()).toStrictEqual(before);
  });

  it("rolls back cancel_week state and prior notification cancellation when notice insertion conflicts", async () => {
    const row = makeSession(); const h = await create({ sessions: [row] });
    await h.ports.outbox.enqueue(attendanceIntent(row.id, 1)); const before = await h.snapshot();
    await expect(h.ports.sessionCommands.cancelWeekAtomically({ ...row, sentinelSessionId: "sentinel", invokerUserId: "user-0", suppressMentions: true, now: attendanceInput.now }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await h.snapshot()).toStrictEqual(before);
  });
});
