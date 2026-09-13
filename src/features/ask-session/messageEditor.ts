import type { Client, Message } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import type { SessionRow } from "../../db/rows.ts";
import { fromDatabaseCall, fromDiscordCall } from "../../errors/effect.ts";
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
): Effect.Effect<void, AppError> =>
  // invariant: 送信が成功したら中断要求があってもID保存まで排他所有を維持する。
  Effect.gen(function* () {
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
  }).pipe(Effect.uninterruptible);

const synchronizeAskMessage = (
  client: Client,
  ctx: AppContext,
  session: Pick<SessionRow, "id">,
  mode: "refresh" | "probe",
  knownMessage?: Message
): Effect.Effect<boolean, AppError> =>
  serializeMessageUpdate(ctx, `ask:${session.id}`, () => Effect.gen(function* () {
    const fresh = yield* fromDatabaseCall(
      () => ctx.ports.sessions.findSessionById(session.id),
      "Failed to reload session for ask message update."
    );
    if (!fresh?.askMessageId) { return false; }
    const messageId = fresh.askMessageId;
    if (mode === "probe") {
      const exists = yield* fromDiscordCall(async () => {
        const channel = await getTextChannel(client, fresh.channelId);
        return channel.messages.fetch(messageId);
      }, "Failed to probe ask message.").pipe(
        Effect.as(true),
        Effect.catchAll(error => isUnknownMessageError(error.cause) ? Effect.succeed(false) : Effect.fail(error))
      );
      if (exists) { return false; }
    }
    const [responses, memberRows] = yield* Effect.all([
      fromDatabaseCall(() => ctx.ports.responses.listResponses(fresh.id), "Failed to load ask responses."),
      fromDatabaseCall(() => ctx.ports.members.listMembers(), "Failed to load ask members.")
    ], { concurrency: 2 });
    const rendered = renderAskBody(buildAskMessageViewModel(fresh, responses, memberRows));
    const recreate = (): Effect.Effect<boolean, AppError> => fromDiscordCall(
      () => getTextChannel(client, fresh.channelId), "Failed to load channel for ask message recovery."
    ).pipe(Effect.flatMap(channel => recreateAskMessage(channel, ctx, fresh, rendered)), Effect.as(true));
    if (mode === "probe") { return yield* recreate(); }
    return yield* fromDiscordCall(async () => {
      if (knownMessage?.id === messageId) { return knownMessage.edit(rendered); }
      const channel = await getTextChannel(client, fresh.channelId);
      const message = await channel.messages.fetch(messageId);
      return message.edit(rendered);
    }, "Failed to edit ask message.").pipe(
      Effect.as(false),
      Effect.catchAll(error => isUnknownMessageError(error.cause) ? recreate() : Effect.fail(error))
    );
  }));

/** 現在のDB状態から再描画し、削除済みなら同じ更新経路で再生成する。 */
export const updateAskMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">, knownMessage?: Message
): Effect.Effect<void, AppError> => synchronizeAskMessage(client, ctx, session, "refresh", knownMessage).pipe(Effect.asVoid);

/** 正常messageは編集せず、削除済みmessageの復旧をInteractionと同じqueueへ載せる。 */
export const probeAskMessage = (
  client: Client, ctx: AppContext, session: Pick<SessionRow, "id">
): Effect.Effect<boolean, AppError> => synchronizeAskMessage(client, ctx, session, "probe");
