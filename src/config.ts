import { env } from "./env.js";

export type Hhmm = Readonly<{ hour: number; minute: number }>;

// why: runtime tunables 集約 → ADR-0013

// why: cron 送信スケジュールは暫定 → ADR-0007
export const CRON_ASK_SCHEDULE = "0 8 * * 5" as const;
// invariant: CRON_ASK_SCHEDULE と同じ時刻を HH:MM で保持し reconciler の ask 窓判定が参照する。
export const ASK_START_HHMM = { hour: 8, minute: 0 } as const satisfies Hhmm;
export const CRON_DEADLINE_SCHEDULE = "30 21 * * 5" as const;
// jst: POSTPONE_DEADLINE="24:00" = 候補日翌日 00:00 JST に対応する土曜境界 tick。
export const CRON_POSTPONE_DEADLINE_SCHEDULE = "0 0 * * 6" as const;
// why: reminder 到達判定を毎 tick で行う → ADR-0024
export const CRON_REMINDER_SCHEDULE = "* * * * *" as const;
export const ASK_DEADLINE_HHMM = { hour: 21, minute: 30 } as const satisfies Hhmm;
export const REMINDER_LEAD_MINUTES = -15 as const;
// why: 開催確定からリマインド予定まで余裕がない場合は送信をスキップする（requirements/base.md §5.2）
export const REMINDER_SKIP_THRESHOLD_MINUTES = 10 as const;
// why: reminder claim が長時間戻らない場合に保持プロセス crash とみなして reclaim する閾値。
// @see ADR-0024, ADR-0033
export const REMINDER_CLAIM_STALENESS_MS = 5 * 60 * 1000;
// why: 1 分 tick 周期を超える tick を warn で早期検知し noOverlap の健全性を観測する。
export const TICK_DURATION_WARN_MS = 10_000;
// why: メンバー数 SSoT → ADR-0012。循環参照回避のため定義は env.ts、消費側は config 経由で import。
export { MEMBER_COUNT_EXPECTED } from "./env.js";
// why: healthcheck ping でプロセス死亡を検知する → ADR-0034
export const HEALTHCHECK_PING_INTERVAL_CRON = "*/1 * * * *" as const;
// why: healthchecks.io 無応答時も起動/tick を止めないための HTTP タイムアウト → ADR-0034
export const HEALTHCHECK_PING_TIMEOUT_MS = 5_000 as const;

// why: Discord send outbox worker → ADR-0035。state transitions が同 tx で enqueue し worker が非同期送信。
export const CRON_OUTBOX_WORKER_SCHEDULE = "*/10 * * * * *" as const;
// single-instance: rate limit を踏みにくい 1 tick 処理上限。
export const OUTBOX_WORKER_BATCH_LIMIT = 10 as const;
// race: worker crash 時に claimExpiresAt 経過で reclaim される最大保持時間（tick 周期の数倍）。
export const OUTBOX_CLAIM_DURATION_MS = 30_000 as const;
// why: 失敗時の指数バックオフ列。attempt_count-1 を index に使い、超過分は末尾値で頭打ち。
export const OUTBOX_BACKOFF_MS_SEQUENCE = [
  1_000,
  2_000,
  5_000,
  15_000,
  60_000,
  300_000,
  900_000
] as const satisfies readonly number[];
// why: dead letter (status=FAILED) へ落とす attempt 上限。以降は /status 警告で運用者が手動対応。
export const OUTBOX_MAX_ATTEMPTS = 10 as const;
// why: /status の invariant 警告で多重失敗疑いとして拾う閾値。
export const OUTBOX_STRANDED_ATTEMPTS_THRESHOLD = 5 as const;
// why: 終端行 (DELIVERED / FAILED) の retention。週次運用前提で DELIVERED は直近週の audit 用、
//   FAILED は dead letter 調査用としてより長く保持する。@see ADR-0042
export const OUTBOX_RETENTION_DELIVERED_MS = 7 * 24 * 60 * 60 * 1_000;
export const OUTBOX_RETENTION_FAILED_MS = 30 * 24 * 60 * 60 * 1_000;
// jst: オフピーク帯 (4:00 JST) で 1 日 1 回 prune。deploy 禁止窓 (金 17:30〜土 01:00 JST) と重ならない。
export const CRON_OUTBOX_RETENTION_SCHEDULE = "0 4 * * *" as const;

// why: shardReady 再接続時の replay debounce。in-flight lock + 時刻 debounce 併用。
// @see ADR-0036
export const RECONNECT_REPLAY_DEBOUNCE_MS = 30_000;

const parseHhmm = (value: string): Hhmm => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid HH:MM format: ${value}`);
  }
  const [, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (minute < 0 || minute > 59) {
    throw new Error(`Invalid HH:MM minute: ${value}`);
  }
  // jst: "24:00" のみ境界表記として許可、他の 24 超え表記は env schema で既に排除済み。
  if (hour === 24 && minute === 0) {
    return { hour, minute };
  }
  if (hour < 0 || hour > 23) {
    throw new Error(`Invalid HH:MM hour: ${value}`);
  }
  return { hour, minute };
};

// invariant: POSTPONE_DEADLINE は env schema で literal 固定済み。ここでは runtime tunable 形式へ正規化する。
export const POSTPONE_DEADLINE_HHMM = parseHhmm(env.POSTPONE_DEADLINE);
