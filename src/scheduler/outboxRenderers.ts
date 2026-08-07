import type { MessageCreateOptions } from "discord.js";
import { z } from "zod";

import type { AppContext } from "../appContext.js";
import type { OutboxEntry } from "../db/ports.js";
import { cancelWeekMessages } from "../features/cancel-week/messages.js";
import { renderAskBody } from "../features/ask-session/render.js";
import {
  buildAskMessageViewModel,
  buildSettleNoticeViewModel,
  renderSettleNotice
} from "../features/ask-session/viewModel.js";
import { renderDecidedAnnouncement } from "../features/decided-announcement/render.js";
import { buildDecidedAnnouncementViewModel } from "../features/decided-announcement/viewModel.js";
import { renderPostponeBody } from "../features/postpone-voting/render.js";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.js";
import { buildReminderContent } from "../features/reminder/send.js";

type Renderer = (input: {
  readonly ctx: AppContext;
  readonly entry: OutboxEntry;
}) => Promise<MessageCreateOptions | undefined>;

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
  ask_body: async ({ ctx, entry }) => {
    const session = await ctx.ports.sessions.findSessionById(entry.sessionId);
    if (!session) {return undefined;}
    const [responses, members] = await Promise.all([
      ctx.ports.responses.listResponses(session.id),
      ctx.ports.members.listMembers()
    ]);
    return renderAskBody(buildAskMessageViewModel(session, responses, members));
  },
  settle_notice: async ({ entry }) => {
    const extra = parseExtra(settleNoticeExtraSchema, entry.payload.extra);
    return extra
      ? renderSettleNotice(buildSettleNoticeViewModel(extra.reason, {
          ...(extra.forceSuppressMentions === undefined
            ? {}
            : { forceSuppressMentions: extra.forceSuppressMentions })
        }))
      : undefined;
  },
  postpone_vote: async ({ ctx, entry }) => {
    const session = await ctx.ports.sessions.findSessionById(entry.sessionId);
    if (!session) {return undefined;}
    const [responses, members] = await Promise.all([
      ctx.ports.responses.listResponses(session.id),
      ctx.ports.members.listMembers()
    ]);
    return renderPostponeBody(buildPostponeMessageViewModel(session, responses, members, {
      disabled: session.status !== "POSTPONE_VOTING"
    }));
  },
  decided_announcement: async ({ ctx, entry }) => {
    const session = await ctx.ports.sessions.findSessionById(entry.sessionId);
    if (
      !session ||
      (session.status !== "DECIDED" && session.status !== "COMPLETED") ||
      !session.decidedStartAt
    ) {
      return undefined;
    }
    const [responses, members] = await Promise.all([
      ctx.ports.responses.listResponses(session.id),
      ctx.ports.members.listMembers()
    ]);
    const vm = buildDecidedAnnouncementViewModel(session, responses, members);
    return vm ? renderDecidedAnnouncement(vm) : undefined;
  },
  reminder: async ({ ctx, entry }) => {
    const session = await ctx.ports.sessions.findSessionById(entry.sessionId);
    if (
      !session ||
      (session.status !== "DECIDED" && session.status !== "COMPLETED") ||
      !session.decidedStartAt
    ) {
      return undefined;
    }
    return { content: buildReminderContent(session.decidedStartAt) };
  },
  cancel_week_notice: async ({ entry }) => {
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
  }
};

export const renderOutboxPayload = async (
  ctx: AppContext,
  entry: OutboxEntry
): Promise<MessageCreateOptions | undefined> => {
  const renderer = renderers[entry.payload.renderer];
  return renderer ? renderer({ ctx, entry }) : undefined;
};
