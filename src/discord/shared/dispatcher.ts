import {
  type ButtonInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  MessageFlags
} from "discord.js";

import type { AppContext } from "../../appContext.js";
import { logger } from "../../logger.js";
import { rejectMessages } from "../../features/interaction-reject/messages.js";
import { sendAskMessage } from "../../features/ask-session/send.js";
import { buildFeatureRegistry, type FeatureRegistry } from "../registry/index.js";
import { featureModules } from "../registry/modules.js";
import { cheapFirstGuard, GUARD_REASON_TO_MESSAGE, buildEphemeralReject } from "./guards.js";
import type {
  AppReadyState,
  InteractionHandlerDeps,
  SendAsk
} from "./interactionHandlerDeps.js";

export type { AppReadyState, InteractionHandlerDeps, SendAsk };

const STARTUP_NOT_READY_MESSAGE = "起動処理中です。数秒待って再度お試しください。";

const buildNotReadyPayload = (): InteractionReplyOptions => ({
  content: STARTUP_NOT_READY_MESSAGE,
  flags: MessageFlags.Ephemeral
});

const logNotReadyRejection = (interaction: Interaction, reason?: string): void => {
  logger.info(
    {
      event: "interaction.rejected_not_ready",
      interactionId: interaction.id,
      userId: interaction.user?.id,
      customId: interaction.isButton() ? interaction.customId : undefined,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
      reason
    },
    "Rejected interaction because startup/reconnect is not ready."
  );
};

const handleNotReadyInteraction = async (
  interaction: Interaction,
  reason?: string
): Promise<boolean> => {
  if (interaction.isButton()) {
    await interaction.deferUpdate();
    await interaction.followUp(buildNotReadyPayload());
    logNotReadyRejection(interaction, reason);
    return true;
  }

  if (interaction.isChatInputCommand()) {
    await interaction.reply(buildNotReadyPayload());
    logNotReadyRejection(interaction, reason);
    return true;
  }

  return false;
};

const handleButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  registry: FeatureRegistry
): Promise<void> => {
  // why: ガード拒否理由ごとに別文言で返し、ユーザーに原因を伝える。
  const reason = cheapFirstGuard(interaction.guildId, interaction.channelId, interaction.user.id);
  if (reason) {
    await interaction.followUp(buildEphemeralReject(GUARD_REASON_TO_MESSAGE[reason]));
    return;
  }

  const route = registry.resolveButton(interaction.customId);
  if (route) {
    await route.handle(interaction, deps, { acknowledged: true });
    return;
  }

  // ack: deferUpdate() は dispatcher 入口で実行済み。stale ボタンは followUp で ephemeral 通知する。
  logger.warn(
    {
      interactionId: interaction.id,
      userId: interaction.user.id,
      customId: interaction.customId,
      reason: "unknown_or_stale_button"
    },
    "Unknown or stale button custom_id."
  );

  await interaction.followUp({
    content: rejectMessages.staleButton,
    flags: MessageFlags.Ephemeral
  });
};

/**
 * Dispatch a Discord interaction to its registered feature handler.
 *
 * @remarks
 * registry-driven。新 feature 追加時にこの関数の編集は不要 (ADR-0041)。
 * registry を DI 可能にしてあり、テストでは差し替え可能。
 */
export const handleInteraction = async (
  interaction: Interaction,
  deps: InteractionHandlerDeps,
  registry: FeatureRegistry = defaultRegistry
): Promise<void> => {
  const readyState = deps.getReadyState?.() ?? { ready: true, reason: undefined };
  if (!readyState.ready) {
    const handled = await handleNotReadyInteraction(interaction, readyState.reason);
    if (handled) {
      return;
    }
  }

  if (interaction.isChatInputCommand()) {
    const route = registry.resolveCommand(interaction.commandName);
    if (route) {
      await route.handle(interaction, deps);
      return;
    }

    await interaction.reply({
      content: rejectMessages.unknownCommand,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton()) {
    await interaction.deferUpdate();
    await handleButton(interaction, deps, registry);
    return;
  }

  if (interaction.isAutocomplete()) {
    return;
  }
};

// why: アプリ起動時に 1 度だけ build (fail-fast)。検査結果は登録済 feature が変わらない限り不変。
const defaultRegistry: FeatureRegistry = buildFeatureRegistry(featureModules);

export const registerInteractionHandlers = (
  client: Client,
  context: AppContext,
  options: {
    readonly getReadyState?: () => AppReadyState;
    readonly registry?: FeatureRegistry;
    readonly wakeScheduler?: (reason: string) => void;
  } = {}
): void => {
  const registry = options.registry ?? defaultRegistry;
  client.on("interactionCreate", (interaction) => {
    // ack: 3 秒制約に備え入口で try/catch を集約する。
    void (async () => {
      try {
        const readyDeps =
          options.getReadyState === undefined
            ? {}
            : { getReadyState: options.getReadyState };
        await handleInteraction(
          interaction,
          {
            client,
            context,
            ...readyDeps,
            ...(options.wakeScheduler ? { wakeScheduler: options.wakeScheduler } : {}),
            sendAsk: (args) => sendAskMessage(client, { ...args, context })
          },
          registry
        );
      } catch (err: unknown) {
        const customId = interaction.isMessageComponent() ? interaction.customId : undefined;

        logger.error(
          {
            err,
            interactionId: interaction.id,
            userId: interaction.user?.id,
            customId
          },
          "interaction handler crashed"
        );

        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: rejectMessages.internalError,
              flags: MessageFlags.Ephemeral
            });
          }
        } catch {
          // race: エラー通知自体の失敗は握りつぶし、二重障害で unhandled rejection を作らない。
        }
      }
    })();
  });
};
