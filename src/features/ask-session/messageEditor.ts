import type { Client, Message } from "discord.js";
import { errAsync, ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.ts";
import type { SessionRow } from "../../db/rows.ts";
import { fromDatabaseCall, fromDiscordCall } from "../../errors/result.ts";
import { isUnknownMessageError } from "../../discord/shared/discordErrors.ts";
import { logger } from "../../logger.ts";
import { getTextChannel } from "../../discord/shared/channels.ts";
import { renderAskBody } from "./render.ts";
import { buildAskMessageViewModel } from "./viewModel.ts";
import type { AppError } from "../../errors/index.ts";
import { serializeMessageUpdate } from "../../discord/shared/messageUpdates.ts";

const recreateAskMessage = (
  channel: Awaited<ReturnType<typeof getTextChannel>>,
  ctx: AppContext,
  session: SessionRow,
  rendered: ReturnType<typeof renderAskBody>
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const sent = yield* fromDiscordCall(
      () => channel.send(rendered),
      "Failed to recreate deleted ask message."
    );
    yield* fromDatabaseCall(
      () => ctx.ports.sessions.updateAskMessageId(session.id, sent.id),
      "Failed to persist recreated ask message id."
    );
    logger.warn(
      {
        event: "reconciler.message_recreated",
        sessionId: session.id,
        weekKey: session.weekKey,
        previousMessageId: session.askMessageId,
        messageId: sent.id
      },
      "Reconciler: recreated ask message after Unknown Message (10008)."
    );
    return okAsync(undefined);
  });

const synchronizeAskMessage = (
  client: Client,
  ctx: AppContext,
  session: Pick<SessionRow, "id">,
  mode: "refresh" | "probe",
  knownMessage?: Message
): ResultAsync<boolean, AppError> =>
  serializeMessageUpdate(ctx, `ask:${session.id}`, () => safeTry(async function* () {
    const fresh = yield* fromDatabaseCall(
      () => ctx.ports.sessions.findSessionById(session.id),
      "Failed to reload session for ask message update."
    );
    if (!fresh?.askMessageId) { return okAsync(false); }
    const messageId = fresh.askMessageId;
    if (mode === "probe") {
      const exists = yield* fromDiscordCall(async () => {
        const channel = await getTextChannel(client, fresh.channelId);
        return channel.messages.fetch(messageId);
      }, "Failed to probe ask message.").map(() => true).orElse(error =>
        isUnknownMessageError(error.cause) ? okAsync(false) : errAsync(error)
      );
      if (exists) { return okAsync(false); }
    }
    const [responses, memberRows] = yield* ResultAsync.combine([
      fromDatabaseCall(() => ctx.ports.responses.listResponses(fresh.id), "Failed to load ask responses."),
      fromDatabaseCall(() => ctx.ports.members.listMembers(), "Failed to load ask members.")
    ]);
    const rendered = renderAskBody(buildAskMessageViewModel(fresh, responses, memberRows));
    const recreate = (): ResultAsync<boolean, AppError> => fromDiscordCall(
      () => getTextChannel(client, fresh.channelId), "Failed to load channel for ask message recovery."
    ).andThen(channel => recreateAskMessage(channel, ctx, fresh, rendered)).map(() => true);
    if (mode === "probe") { return recreate(); }
    return fromDiscordCall(async () => {
      if (knownMessage?.id === messageId) { return knownMessage.edit(rendered); }
      const channel = await getTextChannel(client, fresh.channelId);
      const message = await channel.messages.fetch(messageId);
      return message.edit(rendered);
    }, "Failed to edit ask message.").map(() => false).orElse(error => {
      if (!isUnknownMessageError(error.cause)) { return errAsync(error); }
      return recreate();
    });
  }));

/** 現在のDB状態から再描画し、削除済みなら同じ更新経路で再生成する。 */
export const updateAskMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">, knownMessage?: Message
): ResultAsync<void, AppError> => synchronizeAskMessage(client, ctx, session, "refresh", knownMessage).map(() => undefined);

/** 正常messageは編集せず、削除済みmessageの復旧をInteractionと同じqueueへ載せる。 */
export const probeAskMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">
): ResultAsync<boolean, AppError> => synchronizeAskMessage(client, ctx, session, "probe");
