import type { Client, Message } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import type { SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall, fromDiscordCall } from "../../errors/effect.ts";
import { getTextChannel } from "../../discord/shared/channels.ts";
import { serializeMessageUpdate } from "../../discord/shared/messageUpdates.ts";
import { isUnknownMessageError } from "../../discord/shared/discordErrors.ts";
import { logger } from "../../logger.ts";
import { askMessages } from "../ask-session/messages.ts";
import { renderPostponeBody } from "./render.ts";
import { buildPostponeMessageViewModel } from "./viewModel.ts";
import { postponeMessages } from "./messages.ts";

const displayOptions = (session: SessionRow): { readonly disabled: boolean; readonly footerText?: string } => {
  switch (session.status) {
    case "POSTPONE_VOTING": return { disabled: false };
    case "POSTPONED": return { disabled: true, footerText: postponeMessages.postpone.footerDecided };
    case "SKIPPED": return { disabled: true, footerText: askMessages.ask.footerSkipped };
    default: return { disabled: true, footerText: postponeMessages.postpone.footerCancelled };
  }
};

const synchronizePostponeMessage = (
  client: Client,
  ctx: AppContext,
  session: Pick<SessionRow, "id">,
  mode: "refresh" | "probe",
  knownMessage?: Message
): Effect.Effect<boolean, AppError> =>
  serializeMessageUpdate(ctx, `postpone:${session.id}`, () => Effect.gen(function* () {
    const fresh = yield* fromDatabaseCall(
      () => ctx.ports.sessions.findSessionById(session.id), "Failed to reload postpone session."
    );
    if (!fresh?.postponeMessageId) { return false; }
    const messageId = fresh.postponeMessageId;
    if (mode === "probe") {
      const exists = yield* fromDiscordCall(async () => {
        const channel = await getTextChannel(client, fresh.channelId);
        return channel.messages.fetch(messageId);
      }, "Failed to probe postpone message.").pipe(
        Effect.as(true),
        Effect.catchAll(error => isUnknownMessageError(error.cause) ? Effect.succeed(false) : Effect.fail(error))
      );
      if (exists) { return false; }
    }
    const [responses, memberRows] = yield* Effect.all([
      fromDatabaseCall(() => ctx.ports.responses.listResponses(fresh.id), "Failed to load postpone responses."),
      fromDatabaseCall(() => ctx.ports.members.listMembers(), "Failed to load postpone members.")
    ], { concurrency: 2 });
    const rendered = renderPostponeBody(buildPostponeMessageViewModel(fresh, responses, memberRows, displayOptions(fresh)));
    // invariant: 送信が成功したら中断要求があってもID保存まで排他所有を維持する。
    const recreate = (): Effect.Effect<boolean, AppError> => Effect.gen(function* () {
      const channel = yield* fromDiscordCall(
        () => getTextChannel(client, fresh.channelId), "Failed to load postpone recovery channel."
      );
      const sent = yield* fromDiscordCall(() => channel.send(rendered), "Failed to recreate postpone message.");
      yield* fromDatabaseCall(
        () => ctx.ports.sessions.updatePostponeMessageId(fresh.id, sent.id), "Failed to persist recreated postpone message ID."
      );
      logger.warn({ event: "reconciler.message_recreated", sessionId: fresh.id, previousMessageId: messageId, messageId: sent.id },
        "Recreated postpone message after Unknown Message.");
      return true;
    }).pipe(Effect.uninterruptible);
    if (mode === "probe") { return yield* recreate(); }
    const editPayload = { content: rendered.content ?? "", ...(rendered.components ? { components: rendered.components } : {}) };
    return yield* fromDiscordCall(async () => {
      if (knownMessage?.id === messageId) { return knownMessage.edit(editPayload); }
      const channel = await getTextChannel(client, fresh.channelId);
      const message = await channel.messages.fetch(messageId);
      return message.edit(editPayload);
    }, "Failed to edit postpone message.").pipe(
      Effect.as(false),
      Effect.catchAll(error => isUnknownMessageError(error.cause) ? recreate() : Effect.fail(error))
    );
  }));

/** 投票確定・週取消を含む現在のDB状態から再描画する。 */
export const updatePostponeMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">, knownMessage?: Message
): Effect.Effect<void, AppError> => synchronizePostponeMessage(client, ctx, session, "refresh", knownMessage).pipe(Effect.asVoid);

/** 正常messageは編集せず、削除済みmessageの復旧をInteractionと同じqueueへ載せる。 */
export const probePostponeMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">
): Effect.Effect<boolean, AppError> => synchronizePostponeMessage(client, ctx, session, "probe");
