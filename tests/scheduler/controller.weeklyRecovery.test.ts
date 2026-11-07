import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerController, type SchedulerController } from "../../src/scheduler/controller.ts";
import { runDeadlineTick, runPostponeDeadlineTick, runReminderTick } from "../../src/scheduler/index.ts";
import { SCHEDULER_MIN_TIMER_DELAY_MS } from "../../src/config.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { deferred } from "../helpers/deferred.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("weekly recovery after old active work", () => {
  let controller: SchedulerController | undefined;
  let releaseSend: (() => void) | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    controller?.stop(); releaseSend?.(); await controller?.drain();
    controller = undefined; releaseSend = undefined;
    vi.clearAllTimers(); vi.useRealTimers();
  });

  it.each([
    { time: "2026-04-24T01:00:00Z", createsAuto: true },
    { time: "2026-04-24T12:30:00Z", createsAuto: false },
    { time: "2026-04-24T13:00:00Z", createsAuto: false }
  ])("settles the previous week's due ASKING before considering weekly recovery at $time", async ({ time, createsAuto }) => {
    vi.setSystemTime(new Date(time));
    const old = buildSessionRow({ id: "previous-week", source: "manual", requestId: "previous-request",
      candidateDateIso: "2026-04-17", askMessageId: null });
    const context = createTestAppContext({ now: () => new Date(), seed: { sessions: [old] } });
    const client = stubClient(undefined);
    controller = createSchedulerController({ client, context, logger,
      runDeadlineTick: () => runDeadlineTick(client, context),
      runPostponeDeadlineTick: () => runPostponeDeadlineTick(client, context),
      runReminderTick: () => runReminderTick(client, context) });
    await controller.recompute("supervisor");
    expect(await context.ports.sessions.findSessionById(old.id)).toMatchObject({ status: "COMPLETED", cancelReason: "deadline_unanswered" });
    expect(context.ports.heldEvents.listHeldEvents()).toStrictEqual([]);
    const created = context.ports.sessions.listSessions().filter(session => session.weekKey === "2026-W17");
    expect(created.map(({ source, candidateDateIso, status }) => ({ source, candidateDateIso, status })))
      .toStrictEqual(createsAuto ? [{ source: "weekly_auto", candidateDateIso: "2026-04-24", status: "ASKING" }] : []);
    expect(context.ports.outbox.listEntries().filter(entry => entry.payload.renderer === "ask_body").map(entry => entry.sessionId))
      .toStrictEqual(created.map(session => session.id));
  });

  it("keeps DECIDED active until reminder delivery commits, then permits the next supervisor's weekly recovery", async () => {
    vi.setSystemTime(new Date("2026-04-24T01:00:00Z"));
    const old = buildSessionRow({ id: "previous-decided", source: "manual", requestId: "decided-request",
      candidateDateIso: "2026-04-17", status: "DECIDED", askMessageId: "old-message" });
    const context = createTestAppContext({ now: () => new Date(), seed: { sessions: [old] } });
    const accepted = deferred<{ id: string }>();
    releaseSend = () => accepted.resolve({ id: "reminder-message" });
    const { channel } = stubChannel();
    channel.send.mockImplementationOnce(async payload => ({ ...(await accepted.promise), payload }));
    const client = stubClient(channel);
    controller = createSchedulerController({ client, context, logger,
      runDeadlineTick: () => runDeadlineTick(client, context),
      runPostponeDeadlineTick: () => runPostponeDeadlineTick(client, context),
      runReminderTick: () => runReminderTick(client, context) });
    await controller.recompute("supervisor");
    expect(context.ports.sessions.listSessions()).toHaveLength(1);
    expect(context.ports.outbox.listEntries()[0]).toMatchObject({ sessionId: old.id, status: "PENDING",
      payload: expect.objectContaining({ renderer: "reminder" }) });
    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledOnce();
    expect((await context.ports.sessions.findSessionById(old.id))?.status).toBe("DECIDED");
    expect(context.ports.sessions.weeklySchedules.has("2026-W17")).toBe(false);
    accepted.resolve({ id: "reminder-message" });
    await controller.drain();
    expect((await context.ports.sessions.findSessionById(old.id))?.status).toBe("COMPLETED");
    expect(context.ports.heldEvents.listHeldEvents()).toMatchObject([{ sessionId: old.id }]);
    await controller.recompute("supervisor");
    expect(context.ports.sessions.listSessions().filter(session => session.weekKey === "2026-W17"))
      .toMatchObject([{ source: "weekly_auto", status: "ASKING" }]);
  });
});
