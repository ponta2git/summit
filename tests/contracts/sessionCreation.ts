import { describe, expect, it } from "vitest";
import type { CreateSessionInput } from "../../src/db/ports.ts";
import type { AttendanceHarness, AttendanceSeed } from "./attendance.ts";
import { makeSession } from "../testing/fixtures.ts";

const friday = new Date("2026-04-24T08:00:00+09:00");
const input = (overrides: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
  id: "70000000-0000-4000-a000-000000000001", source: "manual", channelId: "channel-1", now: friday, ...overrides
});
const stop = { weekKey: "2026-W17", channelId: "channel-1", invokerUserId: "user-1", suppressMentions: true, now: friday };

export const sessionCreationContract = (label: string, create: (seed?: AttendanceSeed) => Promise<AttendanceHarness>): void => {
  describe(`session admission (${label})`, () => {
    it.each(["2026-04-20", "2026-04-24", "2026-04-25"])("accepts manual on %s and never starts a postpone vote", async day => {
      const h = await create({});
      const now = new Date(`${day}T21:29:59.999+09:00`);
      expect(await h.ports.sessionCommands.createSession(input({ now }))).toMatchObject({ kind: "created",
        session: { source: "manual", candidateDateIso: day, parentSessionId: null, postponeCount: 0 } });
      expect(await h.ports.sessionCommands.settleAskingCancellation({ sessionId: input().id, reason: "absent", now }))
        .toMatchObject({ kind: "transitioned", session: { status: "COMPLETED" } });
      expect((await h.intents()).map(intent => intent.dedupeKey)).toEqual([
        `ask-body-${input().id}`, `settle-notice-${input().id}-absent`
      ]);
    });

    it.each(["21:30:00.000", "23:59:59.999"])("refuses manual at %s without an intent or Session", async time => {
      const h = await create();
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.createSession(input({ now: new Date(`2026-04-24T${time}+09:00`) })))
        .toStrictEqual({ kind: "rejected", reason: "deadline_passed" });
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it.each(["ASKING", "POSTPONE_VOTING", "DECIDED", "CANCELLED"] as const)("blocks another week while %s remains active", async status => {
      const prior = makeSession({ status, source: "legacy", candidateDateIso: "2026-04-17", weekKey: "2026-W16" });
      const h = await create({ sessions: [prior] });
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.createSession(input())).toMatchObject({ kind: "rejected", reason: "active_session", session: { id: prior.id } });
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it.each(["COMPLETED", "POSTPONED", "SKIPPED"] as const)("retains the occupied date of a %s Session but permits another day in the same week", async status => {
      const prior = makeSession({ status, source: "legacy" });
      const h = await create({ sessions: [prior] });
      expect(await h.ports.sessionCommands.createSession(input())).toMatchObject({ kind: "rejected", reason: "date_exists" });
      expect(await h.ports.sessionCommands.createSession(input({ now: new Date("2026-04-25T10:00:00+09:00") })))
        .toMatchObject({ kind: "created", session: { weekKey: "2026-W17", candidateDateIso: "2026-04-25" } });
    });

    it("allows the date of a proven historical skip sentinel without altering it", async () => {
      const prior = makeSession({ status: "SKIPPED", source: "legacy", occupiesDate: false });
      const h = await create({ sessions: [prior] });
      expect(await h.ports.sessionCommands.createSession(input())).toMatchObject({ kind: "created" });
      expect(await h.ports.sessions.findSessionById(prior.id)).toEqual(prior);
    });

    it("replays one request after the date and week change without creating another Session", async () => {
      const h = await create();
      const first = await h.ports.sessionCommands.createSession(input({ requestId: "operation-1" }));
      const before = await h.snapshot();
      const replay = await h.ports.sessionCommands.createSession(input({ id: "70000000-0000-4000-a000-000000000002",
        requestId: "operation-1", now: new Date("2026-04-27T23:00:00+09:00") }));
      expect(replay).toEqual({ ...first, kind: "duplicate" });
      expect(await h.snapshot()).toStrictEqual(before);
    });

    it("stops only auto and lets a manual Session proceed without cancellation", async () => {
      const h = await create();
      expect(await h.ports.sessionCommands.cancelWeekAtomically(stop)).toMatchObject({ kind: "applied", noticeEnqueued: true });
      expect(await h.ports.sessionCommands.createSession(input({ source: "weekly_auto" })))
        .toMatchObject({ kind: "rejected", reason: "auto_disabled" });
      expect(await h.ports.sessionCommands.createSession(input())).toMatchObject({ kind: "created" });
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.cancelWeekAtomically(stop)).toMatchObject({ kind: "already_disabled", noticeEnqueued: false });
      expect(await h.snapshot()).toStrictEqual(before);
      expect((await h.intents()).map(intent => intent.dedupeKey).sort()).toEqual([
        `ask-body-${input().id}`, "weekly-ask-disabled-2026-W17"
      ].sort());
    });

    it("does not stop a generated auto even before delivery or after completion", async () => {
      const h = await create();
      expect(await h.ports.sessionCommands.createSession(input({ source: "weekly_auto" }))).toMatchObject({ kind: "created" });
      const before = await h.snapshot();
      expect(await h.ports.sessionCommands.cancelWeekAtomically(stop)).toMatchObject({ kind: "already_started", noticeEnqueued: false });
      expect(await h.snapshot()).toEqual(before);
      await h.ports.sessionCommands.settleAskingCancellation({ sessionId: input().id, reason: "absent", now: new Date("2026-04-25T00:00:00+09:00") });
      const closed = await h.snapshot();
      expect(await h.ports.sessionCommands.cancelWeekAtomically(stop)).toMatchObject({ kind: "already_started" });
      expect(await h.snapshot()).toEqual(closed);
    });

    it("lets Friday pre-08 manual consume the date without acquiring auto origin", async () => {
      const h = await create();
      expect(await h.ports.sessionCommands.createSession(input({ now: new Date("2026-04-24T07:59:59+09:00") })))
        .toMatchObject({ kind: "created", session: { source: "manual" } });
      expect(await h.ports.sessionCommands.createSession(input({ source: "weekly_auto" })))
        .toMatchObject({ kind: "rejected", reason: "date_exists" });
    });

    it.each(["2026-04-24T07:59:59+09:00", "2026-04-25T08:00:00+09:00"])("does not create auto outside the Friday window at %s", async at => {
      const h = await create();
      expect(await h.ports.sessionCommands.createSession(input({ source: "weekly_auto", now: new Date(at) })))
        .toStrictEqual({ kind: "rejected", reason: "outside_auto_window" });
      expect(await h.intents()).toEqual([]);
    });
  });
};
