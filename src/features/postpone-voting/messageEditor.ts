import type { Client } from "discord.js";
import { ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.ts";
import type { ResponseRow, SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall, fromDiscordCall } from "../../errors/result.ts";
import { getTextChannel } from "../../discord/shared/channels.ts";
import { renderPostponeBody } from "./render.ts";
import { buildPostponeMessageViewModel } from "./viewModel.ts";

export const updatePostponeMessage = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  footerText: string
): ResultAsync<void, AppError> => {
  if (!session.postponeMessageId) {return okAsync(undefined);}
  const messageId = session.postponeMessageId;

  return safeTry(async function* () {
    const [channel, memberRows] = yield* ResultAsync.combine([
      fromDiscordCall(
        () => getTextChannel(client, session.channelId),
        "Failed to load channel for postpone message update."
      ),
      fromDatabaseCall(
        () => ctx.ports.members.listMembers(),
        "Failed to load members for postpone message update."
      )
    ]);
    const rendered = renderPostponeBody(
      buildPostponeMessageViewModel(session, responses, memberRows, {
        disabled: true,
        footerText
      })
    );
    const editPayload = {
      content: rendered.content ?? "",
      ...(rendered.components ? { components: rendered.components } : {})
    };
    const message = yield* fromDiscordCall(
      () => channel.messages.fetch(messageId),
      "Failed to fetch postpone message for update."
    );
    yield* fromDiscordCall(
      () => message.edit(editPayload),
      "Failed to edit postpone message."
    );
    return okAsync(undefined);
  });
};
