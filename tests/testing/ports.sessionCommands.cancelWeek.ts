import type {
  CancelWeekResult,
  SessionCommandsPort,
  SessionRow
} from "../../src/db/ports.js";
import type { FakeHeldEventsPort } from "./ports.heldEvents.js";
import type { FakeOutboxPort } from "./ports.outbox.js";
import type { FakeSessionsPort } from "./ports.sessions.js";
import { recordCall, type AnyCall } from "./ports.shared.js";

const CANCELLABLE = new Set([
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
]);

export const createFakeCancelWeekCommand = (
  calls: AnyCall[],
  sessions: FakeSessionsPort,
  heldEvents: FakeHeldEventsPort,
  outbox: FakeOutboxPort
): Pick<SessionCommandsPort, "cancelWeekAtomically"> => ({
  cancelWeekAtomically: async (input): Promise<CancelWeekResult> => {
    recordCall(calls, "cancelWeekAtomically", { input });
    const sessionSnapshot = sessions.listSessions();
    const outboxSnapshot = outbox.listEntries();
    try {
      const weekSessions = sessions
        .listSessions()
        .filter((session) => session.weekKey === input.weekKey)
        .sort(
          (left, right) =>
            left.postponeCount - right.postponeCount ||
            left.id.localeCompare(right.id)
        );
      for (const session of weekSessions) {
        if (await heldEvents.findBySessionId(session.id)) {
          return {
            kind: "already_held",
            weekKey: input.weekKey,
            session
          };
        }
      }

      let sentinelCreated = false;
      const skippedSessions: SessionRow[] = [];
      if (weekSessions.length === 0) {
        const created = await sessions.createAskSession({
          id: input.sentinelSessionId,
          weekKey: input.weekKey,
          postponeCount: 0,
          candidateDateIso: input.candidateDateIso,
          channelId: input.channelId,
          deadlineAt: input.deadlineAt
        });
        if (!created) {throw new Error("SKIPPED sentinel insert returned no row");}
        const skipped = await sessions.skipSession({
          id: created.id,
          cancelReason: "manual_skip"
        });
        if (!skipped) {throw new Error("SKIPPED sentinel transition failed");}
        skippedSessions.push(skipped);
        sentinelCreated = true;
      } else {
        for (const session of weekSessions) {
          if (!CANCELLABLE.has(session.status)) {continue;}
          const skipped = await sessions.skipSession({
            id: session.id,
            cancelReason: "manual_skip"
          });
          if (skipped) {skippedSessions.push(skipped);}
        }
      }

      const alreadySkipped = weekSessions.filter(
        (session) => session.status === "SKIPPED"
      );
      const anchor = skippedSessions[0] ?? alreadySkipped[0];
      if (!anchor) {
        return {
          kind: "already_closed",
          weekKey: input.weekKey,
          sessions: weekSessions
        };
      }

      const dedupeKey = "cancel-week-notice-" + input.weekKey;
      outbox.cancelForSessionIds(
        [...skippedSessions, ...alreadySkipped].map((session) => session.id),
        dedupeKey,
        input.now
      );
      const notice = await outbox.enqueue({
        kind: "send_message",
        sessionId: anchor.id,
        dedupeKey,
        aggregateRevision: anchor.revision,
        ordinal: 0,
        payload: {
          kind: "send_message",
          channelId: input.channelId,
          renderer: "cancel_week_notice",
          extra: {
            invokerUserId: input.invokerUserId,
            suppressMentions: input.suppressMentions
          }
        }
      });
      return {
        kind:
          skippedSessions.length > 0 || sentinelCreated
            ? "applied"
            : "already_skipped",
        weekKey: input.weekKey,
        skippedSessions,
        sentinelCreated,
        noticeEnqueued: !notice.skipped
      };
    } catch (error: unknown) {
      sessions.restoreSessions(sessionSnapshot);
      outbox.restoreEntries(outboxSnapshot);
      throw error;
    }
  }
});
