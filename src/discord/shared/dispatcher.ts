import {
  type ButtonInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  MessageFlags
} from "discord.js";

import type { AppContext } from "../../appContext.ts";
import { INTERACTION_CONCURRENCY, INTERACTION_REJECTION_CONCURRENCY } from "../../config.ts";
import { logger } from "../../logger.ts";
import { rejectMessages } from "../../features/interaction-reject/messages.ts";
import { sendAskMessage } from "../../features/ask-session/send.ts";
import { buildFeatureRegistry, type FeatureRegistry } from "../registry/index.ts";
import { featureModules } from "../registry/modules.ts";
import { cheapFirstGuard, GUARD_REASON_TO_MESSAGE, buildEphemeralReject } from "./guards.ts";
import type {
  AppReadyState,
  InteractionHandlerDeps,
  SendAsk
} from "./interactionHandlerDeps.ts";

export type { AppReadyState, InteractionHandlerDeps, SendAsk };

const STARTUP_NOT_READY_MESSAGE = "準備中です。数秒待ってもう一度お試しください。";

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
 * registry-driven。新 feature 追加時にこの関数の編集は不要。
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
): { stop(): void; drain(): Promise<void> } => {
  const active = new Set<Promise<void>>();
  const rejecting = new Set<Promise<void>>();
  let stopped = false;
  const registry = options.registry ?? defaultRegistry;
  const track = (work: Promise<void>, owner: Set<Promise<void>>): void => {
    owner.add(work);
    const release = (): void => { owner.delete(work); };
    // invariant: 成否にかかわらず settlement まで slot と drain の所有を維持する。
    void work.then(release, release);
  };
  const rejectBusy = async (interaction: Interaction): Promise<void> => {
    try {
      const payload = buildEphemeralReject(rejectMessages.busy);
      if (interaction.isButton()) {
        await interaction.deferUpdate();
        await interaction.followUp(payload);
      } else if (interaction.isChatInputCommand()) {
        await interaction.reply(payload);
      }
    } catch (error: unknown) {
      logger.warn({ event: "interaction.busy_reply_failed", error, interactionId: interaction.id },
        "Could not send the bounded busy response.");
    }
  };
  const onInteraction = (interaction: Interaction): void => {
    if (stopped) { return; }
    if (active.size >= INTERACTION_CONCURRENCY) {
      // why: 拒否通知自身の API 待機も上限を持ち、飽和時には追加の I/O を開始しない。
      if (rejecting.size < INTERACTION_REJECTION_CONCURRENCY) {
        track(Promise.resolve().then(() => rejectBusy(interaction)), rejecting);
      }
      return;
    }
    // ack: 3 秒制約に備え入口で try/catch を集約する。
    const handling = Promise.resolve().then(async () => {
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
            sendAsk: (args) => sendAskMessage({ ...args, context })
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
          if (interaction.isRepliable()) {
            const payload = buildEphemeralReject(rejectMessages.internalError);
            if (interaction.replied || interaction.deferred) {
              await interaction.followUp(payload);
            } else {
              await interaction.reply(payload);
            }
          }
        } catch {
          // race: エラー通知自体の失敗は握りつぶし、二重障害で unhandled rejection を作らない。
        }
      }
      return undefined;
    });
    track(handling, active);
  };
  client.on("interactionCreate", onInteraction);
  return {
    stop: () => { stopped = true; client.off("interactionCreate", onInteraction); },
    drain: async () => { await Promise.allSettled([...active, ...rejecting]); }
  };
};
