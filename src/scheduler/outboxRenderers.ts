import type { MessageCreateOptions } from "discord.js";
import * as Effect from "effect/Effect";
import { z } from "zod";

import type { AppContext } from "../appContext.ts";
import type { OutboxEntry } from "../db/ports.ts";
import { cancelWeekMessages } from "../features/cancel-week/messages.ts";
import { renderAskBody } from "../features/ask-session/render.ts";
import {
  buildAskMessageViewModel,
  buildSettleNoticeViewModel,
  renderSettleNotice
} from "../features/ask-session/viewModel.ts";
import { renderDecidedAnnouncement } from "../features/decided-announcement/render.ts";
import { buildDecidedAnnouncementViewModel } from "../features/decided-announcement/viewModel.ts";
import { renderPostponeBody } from "../features/postpone-voting/render.ts";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.ts";
import { buildReminderContent } from "../features/reminder/send.ts";
import { settledCall } from "../runtime/effect.ts";

interface RendererInput {
  readonly ctx: AppContext;
  readonly entry: OutboxEntry;
}
type Renderer = (input: RendererInput) => Effect.Effect<MessageCreateOptions | undefined, unknown>;

const cancelWeekNoticeExtraSchema = z.object({
  invokerUserId: z.string(),
  suppressMentions: z.boolean().optional()
});
const settleNoticeExtraSchema = z.object({
  reason: z.enum(["absent", "deadline_unanswered", "saturday_cancelled"]),
  forceSuppressMentions: z.boolean().optional()
});

const parseExtra = <T extends z.ZodType>(
  schema: T,
  extra: Record<string, unknown> | undefined
): z.output<T> | undefined => {
  const result = schema.safeParse(extra ?? {});
  return result.success ? result.data : undefined;
};

// source-of-truth: typed intent renderer registry. Unknown or state-incompatible rows dead-letter.
const renderers: Readonly<Record<string, Renderer>> = {
  ask_body: Effect.fnUntraced(function* ({ ctx, entry }: RendererInput) {
    const session = yield* settledCall(() => ctx.ports.sessions.findSessionById(entry.sessionId));
    if (!session) {return undefined;}
    const [responses, members] = yield* loadAttendance(ctx, session.id);
    return renderAskBody(buildAskMessageViewModel(session, responses, members));
  }),
  settle_notice: ({ entry }) => Effect.sync(() => {
    const extra = parseExtra(settleNoticeExtraSchema, entry.payload.extra);
    return extra
      ? renderSettleNotice(buildSettleNoticeViewModel(extra.reason, {
          ...(extra.forceSuppressMentions === undefined
            ? {}
            : { forceSuppressMentions: extra.forceSuppressMentions })
        }))
      : undefined;
  }),
  postpone_vote: Effect.fnUntraced(function* ({ ctx, entry }: RendererInput) {
    const session = yield* settledCall(() => ctx.ports.sessions.findSessionById(entry.sessionId));
    if (!session) {return undefined;}
    const [responses, members] = yield* loadAttendance(ctx, session.id);
    return renderPostponeBody(buildPostponeMessageViewModel(session, responses, members, {
      disabled: session.status !== "POSTPONE_VOTING"
    }));
  }),
  decided_announcement: Effect.fnUntraced(function* ({ ctx, entry }: RendererInput) {
    const session = yield* settledCall(() => ctx.ports.sessions.findSessionById(entry.sessionId));
    if (
      !session ||
      (session.status !== "DECIDED" && session.status !== "COMPLETED") ||
      !session.decidedStartAt
    ) {
      return undefined;
    }
    const [responses, members] = yield* loadAttendance(ctx, session.id);
    const vm = buildDecidedAnnouncementViewModel(session, responses, members);
    return vm ? renderDecidedAnnouncement(vm) : undefined;
  }),
  reminder: Effect.fnUntraced(function* ({ ctx, entry }: RendererInput) {
    const session = yield* settledCall(() => ctx.ports.sessions.findSessionById(entry.sessionId));
    if (
      !session ||
      (session.status !== "DECIDED" && session.status !== "COMPLETED") ||
      !session.decidedStartAt
    ) {
      return undefined;
    }
    return { content: buildReminderContent(session.decidedStartAt) };
  }),
  cancel_week_notice: ({ entry }) => Effect.sync(() => {
    const extra = parseExtra(cancelWeekNoticeExtraSchema, entry.payload.extra);
    if (!extra) {return undefined;}
    return {
      content: extra.suppressMentions === true
        ? cancelWeekMessages.cancelWeek.suppressedChannelNotice({
            invokerUserId: extra.invokerUserId
          })
        : cancelWeekMessages.cancelWeek.channelNotice({
            invokerUserId: extra.invokerUserId
          })
    };
  })
};

const loadAttendance = (
  ctx: AppContext,
  sessionId: string
): Effect.Effect<[
  Awaited<ReturnType<AppContext["ports"]["responses"]["listResponses"]>>,
  Awaited<ReturnType<AppContext["ports"]["members"]["listMembers"]>>
], unknown> => Effect.all([
  settledCall(() => ctx.ports.responses.listResponses(sessionId)),
  settledCall(() => ctx.ports.members.listMembers())
], { concurrency: 2 });

export const renderOutboxPayload = (
  ctx: AppContext,
  entry: OutboxEntry
): Effect.Effect<MessageCreateOptions | undefined, unknown> => Effect.suspend(() => {
  const renderer = renderers[entry.payload.renderer];
  return renderer ? renderer({ ctx, entry }) : Effect.succeed(undefined);
});
