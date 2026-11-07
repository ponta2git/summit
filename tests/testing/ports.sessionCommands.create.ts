import type { SessionCommandsPort } from "../../src/db/ports.ts";
import { isActiveSession } from "../../src/domain/sessionCreation.ts";
import { deadlineFor, formatCandidateDateIso, isoWeekKey, isWeeklyAskWindow } from "../../src/time/index.ts";
import { buildAskBodyIntent } from "../../src/db/repositories/sessionOutboxIntents.ts";
import type { FakeSessionsPort } from "./ports.sessions.ts";
import { recordCall, type AnyCall } from "./ports.shared.ts";

export const createFakeCreateSessionCommand = (
  calls: AnyCall[], sessions: FakeSessionsPort
): Pick<SessionCommandsPort, "createSession"> => ({
  createSession: async input => {
    recordCall(calls, "createSession", { input });
    const rows = sessions.listSessions();
    const previous = input.requestId && rows.find(row => row.requestId === input.requestId);
    if (previous) { return { kind: "duplicate", session: previous }; }
    const weekKey = isoWeekKey(input.now);
    const candidateDateIso = formatCandidateDateIso(input.now);
    const deadlineAt = deadlineFor(input.now);
    if (input.now >= deadlineAt) { return { kind: "rejected", reason: "deadline_passed" }; }
    if (input.source === "weekly_auto") {
      if (!isWeeklyAskWindow(input.now)) { return { kind: "rejected", reason: "outside_auto_window" }; }
      const week = sessions.weeklySchedules.get(weekKey);
      if (week?.disabledAt) { return { kind: "rejected", reason: "auto_disabled" }; }
      if (week?.autoSessionId) { return { kind: "rejected", reason: "auto_started" }; }
    }
    const sameDate = rows.find(row => row.occupiesDate && row.candidateDateIso === candidateDateIso);
    if (sameDate) { return { kind: "rejected", reason: "date_exists", session: sameDate }; }
    const active = rows.find(row => isActiveSession(row.status));
    if (active) { return { kind: "rejected", reason: "active_session", session: active }; }
    const session = await sessions.createAskSession({
      id: input.id, source: input.source, requestId: input.requestId ?? null,
      weekKey, candidateDateIso, deadlineAt, postponeCount: 0, channelId: input.channelId,
      outbox: [buildAskBodyIntent({ id: input.id, channelId: input.channelId, revision: 0 })]
    });
    if (!session) { throw new Error("Created session could not be reloaded"); }
    if (input.source === "weekly_auto") {
      sessions.weeklySchedules.set(weekKey, { weekKey, autoSessionId: session.id, disabledAt: null });
    }
    return { kind: "created", session };
  }
});
