import type { SessionRow } from "../rows.ts";
import type { EnqueueOutboxInput } from "./outbox.ts";

export type AskCancellationReason =
  | "absent"
  | "deadline_unanswered"
  | "saturday_cancelled";

type IntentSession = Pick<
  SessionRow,
  "id" | "channelId" | "revision"
>;

// Reserved tail ordinals for repair intents anchored to the current Session revision.
export const OUTBOX_RECOVERY_ORDINALS = {
  ask: 32_766,
  postpone: 32_767
} as const;

export const buildAskBodyIntent = (
  session: IntentSession,
  ordinal = 0
): EnqueueOutboxInput => ({
  kind: "send_message",
  sessionId: session.id,
  dedupeKey: `ask-body-${session.id}`,
  aggregateRevision: session.revision,
  ordinal,
  payload: {
    kind: "send_message",
    channelId: session.channelId,
    renderer: "ask_body",
    target: "askMessageId",
    extra: {}
  }
});

export const buildSettleNoticeIntent = (
  session: IntentSession,
  reason: AskCancellationReason,
  options: {
    readonly forceSuppressMentions: boolean;
    readonly ordinal?: number;
  }
): EnqueueOutboxInput => ({
  kind: "send_message",
  sessionId: session.id,
  dedupeKey: `settle-notice-${session.id}-${reason}`,
  aggregateRevision: session.revision,
  ordinal: options.ordinal ?? 0,
  payload: {
    kind: "send_message",
    channelId: session.channelId,
    renderer: "settle_notice",
    extra: {
      reason,
      forceSuppressMentions: options.forceSuppressMentions
    }
  }
});

export const buildPostponeVoteIntent = (
  session: IntentSession,
  ordinal = 1
): EnqueueOutboxInput => ({
  kind: "send_message",
  sessionId: session.id,
  dedupeKey: `postpone-vote-${session.id}`,
  aggregateRevision: session.revision,
  ordinal,
  payload: {
    kind: "send_message",
    channelId: session.channelId,
    renderer: "postpone_vote",
    target: "postponeMessageId",
    extra: {}
  }
});

export const buildDecidedAnnouncementIntent = (
  session: IntentSession,
  ordinal = 0
): EnqueueOutboxInput => ({
  kind: "send_message",
  sessionId: session.id,
  dedupeKey: `decided-announcement-${session.id}`,
  aggregateRevision: session.revision,
  ordinal,
  payload: {
    kind: "send_message",
    channelId: session.channelId,
    renderer: "decided_announcement",
    extra: {}
  }
});

export const buildReminderIntent = (
  session: IntentSession,
  ordinal = 1
): EnqueueOutboxInput => ({
  kind: "send_message",
  sessionId: session.id,
  dedupeKey: `reminder-${session.id}`,
  aggregateRevision: session.revision,
  ordinal,
  payload: {
    kind: "send_message",
    channelId: session.channelId,
    renderer: "reminder",
    extra: {}
  }
});
