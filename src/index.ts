import { randomUUID } from "node:crypto";

import type { ScheduledTask } from "node-cron";
import { RESTEvents } from "discord.js";

import { createAppContext } from "./appContext.js";
import { closeDb, db } from "./db/client.js";
import { waitForInFlightSend } from "./features/ask-session/send.js";
import { createDiscordClient } from "./discord/client.js";
import { registerInteractionHandlers } from "./discord/index.js";
import type { AppReadyState } from "./discord/shared/dispatcher.js";
import { env } from "./env.js";
import { sendHealthcheckPing } from "./healthcheck/ping.js";
import { logger } from "./logger.js";
import { buildMemberReconcileInputs } from "./members/inputs.js";
import { reconcileMembers } from "./members/reconcile.js";
import { runReconciler } from "./scheduler/reconciler.js";
import { createAskScheduler, runStartupRecovery } from "./scheduler/index.js";
import { shutdownGracefully } from "./shutdown.js";
import { HEALTHCHECK_PING_TIMEOUT_MS, RECONNECT_REPLAY_DEBOUNCE_MS } from "./config.js";

const appContext = createAppContext();
const client = createDiscordClient();
const appReadyState: AppReadyState = {
  ready: false,
  reason: "startup"
};
let startupCompleted = false;

const markAppReady = (): void => {
  appReadyState.ready = true;
  appReadyState.reason = undefined;
};

const markAppNotReady = (reason: string): void => {
  appReadyState.ready = false;
  appReadyState.reason = reason;
};

client.on("shardDisconnect", () => {
  if (!startupCompleted) {
    return;
  }

  markAppNotReady("reconnecting");
});

// why: reconnect 時に reconciler + startupRecovery を replay し、disconnect 中に発火した cron tick の
//   Discord 副作用漏れ (ask 未投稿 / settle 中断 / outbox claim stuck) を収束させる (ADR-0036)。
// race: 短時間の再接続フラップで replay を多重起動しないよう in-flight Promise lock で直列化する。
//   また直近 RECONNECT_REPLAY_DEBOUNCE_MS 以内の成功後の再接続は debounce で skip する。
// ack: replay 中は markAppNotReady で dispatcher に load-shed させ、interaction を ephemeral で rejection する。
let replayInFlight: Promise<void> | undefined;
let lastReplaySucceededAt = 0;

const triggerReconnectReplay = (): void => {
  if (!startupCompleted) {
    return;
  }
  if (replayInFlight) {
    // race: 既に replay 実行中。完了時に markAppReady されるので追加起動は不要。
    return;
  }
  const now = Date.now();
  if (now - lastReplaySucceededAt < RECONNECT_REPLAY_DEBOUNCE_MS) {
    // debounce: 直近成功の範囲内ならば skip して ready に戻すのみ。
    markAppReady();
    logger.info(
      {
        event: "reconnect.replay_skipped",
        bootId,
        reason: "debounced",
        sinceLastMs: now - lastReplaySucceededAt
      },
      "Reconnect replay skipped (debounced)."
    );
    return;
  }

  markAppNotReady("replaying");
  const startedAt = Date.now();
  logger.info(
    { event: "reconnect.replay_start", bootId },
    "Reconnect replay started."
  );
  replayInFlight = (async () => {
    try {
      const report = await runReconciler(client, appContext, { scope: "reconnect" });
      await runStartupRecovery(client, appContext);
      lastReplaySucceededAt = Date.now();
      logger.info(
        {
          event: "reconnect.replay_done",
          bootId,
          elapsedMs: lastReplaySucceededAt - startedAt,
          cancelledPromoted: report.cancelledPromoted,
          askCreated: report.askCreated,
          messageResent: report.messageResent,
          staleClaimReclaimed: report.staleClaimReclaimed,
          outboxClaimReleased: report.outboxClaimReleased
        },
        "Reconnect replay completed."
      );
    } catch (error: unknown) {
      logger.error(
        {
          event: "reconnect.replay_failed",
          bootId,
          elapsedMs: Date.now() - startedAt,
          error
        },
        "Reconnect replay failed."
      );
    } finally {
      replayInFlight = undefined;
      // state: 成否に関わらず ready に戻す。失敗時も次 scheduler tick で再収束する (冪等)。
      markAppReady();
    }
  })();
};

client.on("shardReady", () => {
  if (!startupCompleted) {
    return;
  }

  triggerReconnectReplay();
});

registerInteractionHandlers(client, appContext, {
  getReadyState: () => appReadyState
});

// why: scheduler は runStartupRecovery 完了後に生成する。node-cron は schedule() 時点で
//   auto-start するため、モジュール top で生成すると startup recovery と reminder cron tick が
//   並行し、同じ DECIDED セッションに対して二重送信の race を作る (ADR-0024)。
let scheduler: readonly ScheduledTask[] | undefined;

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => {
      if (!scheduler) {
        return;
      }
      for (const task of scheduler) {
        task.stop();
      }
    },
    waitForInFlightSend,
    closeDb,
    destroyClient: () => client.destroy()
  })
    .then((didStart) => {
      if (didStart) {
        process.exit(0);
      }
    })
    .catch((error: unknown) => {
      logger.error({ error, signal }, "Fatal shutdown error.");
      process.exit(1);
    });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // idempotent: once で同一シグナル多重発火を防ぐ。二重 shutdown は shutdownGracefully 側でもガード。
  process.once(signal, () => {
    handleShutdownSignal(signal);
  });
}

// why: 起動フェーズごとの構造化ログで「どこで止まったか」を診断可能にする。
//   bootId は 1 プロセス 1 つで、全フェーズログに同じ値が載る。
// @see docs/adr/0033-startup-invariant-reconciler.md
const bootId = randomUUID();
const bootStartedAt = Date.now();

const logBootPhase = (
  phase: "boot_start" | "db_connect" | "reconcile" | "login" | "ready",
  extra: Record<string, unknown> = {}
): void => {
  logger.info(
    {
      event: "boot.phase",
      phase,
      bootId,
      elapsedMs: Date.now() - bootStartedAt,
      ...extra
    },
    `Boot phase: ${phase}.`
  );
};

const run = async (): Promise<void> => {
  logBootPhase("boot_start");

  // why: env を SSoT とし起動時に DB へ反映 (ADR-0012)
  //   cron 登録・bot login より前に完了させ、失敗時は起動を中止する。
  await reconcileMembers(
    buildMemberReconcileInputs(env.MEMBER_USER_IDS, env.MEMBER_DISPLAY_NAMES),
    db
  );
  logBootPhase("db_connect");

  await client.login(env.DISCORD_TOKEN);
  logBootPhase("login");

  // why: 429 の route/retryAfter を観測性のために購読する (ADR-0019, M11)。
  client.rest.on(RESTEvents.RateLimited, (info) => {
    try {
      logger.warn({
        event: 'discord.rate_limited',
        route: info.route,
        method: info.method,
        majorParameter: info.majorParameter,
        retryAfter: info.retryAfter,
        limit: info.limit,
        timeToReset: info.timeToReset,
        globalLimit: info.global,
      }, 'Discord REST rate limit hit');
    } catch {
      // never let listener throw
    }
  });

  // why: 本番 invariant (DEV_SUPPRESS_MENTIONS 未設定=false) を覆して通知挙動を変えている状態を
  //   見逃さないよう起動時に 1 回だけ warn で明示する。毎送信ログに混ぜるとノイズになるため起動時限定。
  // @see docs/adr/0011-dev-mention-suppression.md
  if (env.DEV_SUPPRESS_MENTIONS) {
    logger.warn(
      { devMentionSuppression: true, mentionSuppression: "client-default" },
      "Dev mention suppression is ON. Push mentions are suppressed and `<@id>` lines are omitted from message bodies."
    );
  }

  // source-of-truth: DB と Discord の invariant を収束させる (C1/N1/H1)。
  //   login 済みで Discord 送信・編集が可能な状態で実行し、CAS 冪等なため scheduler tick との競合は race lost として扱う。
  // race: scheduler (cron) 生成はこの呼び出しの完了**後**。reconciler が reminder claim を revert している間に
  //   reminder tick が走ると同じ claim を見て no-op する設計 (idempotent) のため安全側に倒す。
  // @see docs/adr/0033-startup-invariant-reconciler.md
  const report = await runReconciler(client, appContext, { scope: "startup" });
  logBootPhase("reconcile", {
    cancelledPromoted: report.cancelledPromoted,
    askCreated: report.askCreated,
    messageResent: report.messageResent,
    staleClaimReclaimed: report.staleClaimReclaimed
  });

  // source-of-truth: cron tick 取りこぼし (プロセス落ち / 再起動) を DB から回復する。
  //   login 後に実行することで Discord message の edit もできる状態で呼び出す。
  // race: scheduler は本呼び出しの完了**後に**生成する。先に生成すると reminder tick と
  //   recovery が並行し、同じ DECIDED セッションへ二重送信の race を開く (ADR-0024)。
  await runStartupRecovery(client, appContext);
  startupCompleted = true;
  markAppReady();

  // single-instance: scheduler は 1 プロセスで 1 回のみ生成する。
  scheduler = createAskScheduler({
    client,
    context: appContext,
    ...(env.HEALTHCHECK_PING_URL !== undefined ? { healthcheckUrl: env.HEALTHCHECK_PING_URL } : {})
  });

  // why: FLY_IMAGE_REF (Fly が自動挿入するイメージ参照) → GIT_SHA (CI inject) → 'unknown' の優先順で取得する。
  const commitSha = env.FLY_IMAGE_REF ?? env.GIT_SHA ?? "unknown";
  logBootPhase("ready", {
    // event を 'startup.ready' で上書きし、他フェーズの 'boot.phase' と区別する。
    event: "startup.ready",
    commitSha,
    discordGuildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    memberCount: env.MEMBER_USER_IDS.length,
    nodeVersion: process.version
  });

  // M5: 起動完了後に best-effort で healthchecks.io に ping する（boot ping）。
  //   未設定 (undefined) は no-op。失敗しても起動は継続する。
  //   タイムアウトと成否ログは sendHealthcheckPing が担う (ADR-0034)。
  if (env.HEALTHCHECK_PING_URL !== undefined) {
    const pingUrl = env.HEALTHCHECK_PING_URL;
    void sendHealthcheckPing(pingUrl, { timeoutMs: HEALTHCHECK_PING_TIMEOUT_MS }).then((result) => {
      if (result.ok) {
        logger.info(
          { event: "healthcheck.boot_ping", ok: true, elapsedMs: result.elapsedMs, status: result.status },
          "Healthcheck boot ping."
        );
      } else {
        const failFields =
          result.status !== undefined
            ? { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, status: result.status }
            : { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, errorKind: result.errorKind };
        logger.warn(failFields, "Healthcheck boot ping failed.");
      }
    });
  }

  logger.info(
    {
      guildId: env.DISCORD_GUILD_ID,
      channelId: env.DISCORD_CHANNEL_ID
    },
    "Discord bot started."
  );
};

void run().catch((error: unknown) => {
  markAppNotReady("startup_failed");
  logger.error({ error, bootId }, "Failed to start Discord bot.");
  process.exit(1);
});
