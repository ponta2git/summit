import type { SessionCommandsPort } from "../../src/db/ports.ts";
import type { FakeOutboxPort } from "./ports.outbox.ts";
import type { FakeSessionsPort } from "./ports.sessions.ts";
import { recordCall, type AnyCall } from "./ports.shared.ts";

export const createFakeCancelWeekCommand = (
  calls: AnyCall[], sessions: FakeSessionsPort, outbox: FakeOutboxPort
): Pick<SessionCommandsPort, "cancelWeekAtomically"> => ({
  cancelWeekAtomically: async input => {
    recordCall(calls, "cancelWeekAtomically", { input });
    const week = sessions.weeklySchedules.get(input.weekKey);
    if (week?.autoSessionId) { return { kind: "already_started", weekKey: input.weekKey, noticeEnqueued: false }; }
    if (week?.disabledAt) { return { kind: "already_disabled", weekKey: input.weekKey, noticeEnqueued: false }; }
    sessions.weeklySchedules.set(input.weekKey, {
      weekKey: input.weekKey, autoSessionId: null, disabledAt: input.now
    });
    const notice = await outbox.enqueue({
      kind: "send_message", sessionId: null, weekKey: input.weekKey,
      dedupeKey: `weekly-ask-disabled-${input.weekKey}`, aggregateRevision: 1, ordinal: 0,
      payload: { kind: "send_message", channelId: input.channelId, renderer: "weekly_ask_disabled",
        extra: { invokerUserId: input.invokerUserId, suppressMentions: input.suppressMentions } }
    });
    return { kind: "applied", weekKey: input.weekKey, noticeEnqueued: !notice.skipped };
  }
});
