import type { Client, Message } from "discord.js";
import { ResultAsync, errAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.ts";
import type { SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall, fromDiscordCall } from "../../errors/result.ts";
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
): ResultAsync<boolean, AppError> =>
  serializeMessageUpdate(ctx, `postpone:${session.id}`, () => safeTry(async function* () {
    const fresh = yield* fromDatabaseCall(
      () => ctx.ports.sessions.findSessionById(session.id), "Failed to reload postpone session."
    );
    if (!fresh?.postponeMessageId) { return okAsync(false); }
    const messageId = fresh.postponeMessageId;
    if (mode === "probe") {
      const exists = yield* fromDiscordCall(async () => {
        const channel = await getTextChannel(client, fresh.channelId);
        return channel.messages.fetch(messageId);
      }, "Failed to probe postpone message.").map(() => true).orElse(error =>
        isUnknownMessageError(error.cause) ? okAsync(false) : errAsync(error)
      );
      if (exists) { return okAsync(false); }
    }
    const [responses, memberRows] = yield* ResultAsync.combine([
      fromDatabaseCall(() => ctx.ports.responses.listResponses(fresh.id), "Failed to load postpone responses."),
      fromDatabaseCall(() => ctx.ports.members.listMembers(), "Failed to load postpone members.")
    ]);
    const rendered = renderPostponeBody(buildPostponeMessageViewModel(fresh, responses, memberRows, displayOptions(fresh)));
    const recreate = (): ResultAsync<boolean, AppError> => safeTry(async function* () {
      const channel = yield* fromDiscordCall(
        () => getTextChannel(client, fresh.channelId), "Failed to load postpone recovery channel."
      );
      const sent = yield* fromDiscordCall(() => channel.send(rendered), "Failed to recreate postpone message.");
      yield* fromDatabaseCall(
        () => ctx.ports.sessions.updatePostponeMessageId(fresh.id, sent.id), "Failed to persist recreated postpone message ID."
      );
      logger.warn({ event: "reconciler.message_recreated", sessionId: fresh.id, previousMessageId: messageId, messageId: sent.id },
        "Recreated postpone message after Unknown Message.");
      return okAsync(true);
    });
    if (mode === "probe") { return recreate(); }
    const editPayload = { content: rendered.content ?? "", ...(rendered.components ? { components: rendered.components } : {}) };
    return fromDiscordCall(async () => {
      if (knownMessage?.id === messageId) { return knownMessage.edit(editPayload); }
      const channel = await getTextChannel(client, fresh.channelId);
      const message = await channel.messages.fetch(messageId);
      return message.edit(editPayload);
    }, "Failed to edit postpone message.").map(() => false).orElse(error => {
      if (!isUnknownMessageError(error.cause)) { return errAsync(error); }
      return recreate();
    });
  }));

/** 投票確定・週取消を含む現在のDB状態から再描画する。 */
export const updatePostponeMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">, knownMessage?: Message
): ResultAsync<void, AppError> => synchronizePostponeMessage(client, ctx, session, "refresh", knownMessage).map(() => undefined);

/** 正常messageは編集せず、削除済みmessageの復旧をInteractionと同じqueueへ載せる。 */
export const probePostponeMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">
): ResultAsync<boolean, AppError> => synchronizePostponeMessage(client, ctx, session, "probe");
