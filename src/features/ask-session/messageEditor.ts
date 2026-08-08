import type { Client } from "discord.js";
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

export const updateAskMessage = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): ResultAsync<void, AppError> => {
  if (!session.askMessageId) {return okAsync(undefined);}
  const messageId = session.askMessageId;

  return safeTry(async function* () {
    const [channel, memberRows, fresh] = yield* ResultAsync.combine([
      fromDiscordCall(
        () => getTextChannel(client, session.channelId),
        "Failed to load channel for ask message update."
      ),
      fromDatabaseCall(
        () => ctx.ports.members.listMembers(),
        "Failed to load members for ask message update."
      ),
      fromDatabaseCall(
        () => ctx.ports.sessions.findSessionById(session.id),
        "Failed to reload session for ask message update."
      )
    ]);
    if (!fresh) {return okAsync(undefined);}
    const responses = yield* fromDatabaseCall(
      () => ctx.ports.responses.listResponses(fresh.id),
      "Failed to load responses for ask message update."
    );
    const rendered = renderAskBody(buildAskMessageViewModel(fresh, responses, memberRows));
    const fetched = yield* fromDiscordCall(
      () => channel.messages.fetch(messageId),
      "Failed to fetch ask message for update."
    ).orElse((error) => {
      if (isUnknownMessageError(error.cause)) {
        return recreateAskMessage(channel, ctx, session, rendered).map(() => undefined);
      }
      return errAsync(error);
    });
    if (fetched === undefined) {return okAsync(undefined);}
    yield* fromDiscordCall(
      () => fetched.edit(rendered),
      "Failed to edit ask message."
    );
    return okAsync(undefined);
  });
};
