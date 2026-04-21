import { env } from "./env.js";

export type Hhmm = Readonly<{ hour: number; minute: number }>;

// why: runtime tunables を config.ts に集約 (ADR-0013)
// why: cron 送信スケジュールは暫定 → ADR-0007
export const CRON_ASK_SCHEDULE = "0 8 * * 5" as const;
// why: CRON_ASK_SCHEDULE ("0 8 * * 5") と同じ値を HH:MM 形式で表現する。reconciler の
//   「金曜 ask 窓内か」判定で参照するための SSoT。ADR/コメントに "08:00" を書き写さない (ADR-0022)。
export const ASK_START_HHMM = { hour: 8, minute: 0 } as const satisfies Hhmm;
export const CRON_DEADLINE_SCHEDULE = "30 21 * * 5" as const;
// jst: 土 00:00 JST = POSTPONE_DEADLINE="24:00" の「候補日翌日 00:00 JST」に対応する。
export const CRON_POSTPONE_DEADLINE_SCHEDULE = "0 0 * * 6" as const;
// jst: 15 分前リマインドは毎分 tick で due 判定する。ADR-0024。
export const CRON_REMINDER_SCHEDULE = "* * * * *" as const;
export const ASK_DEADLINE_HHMM = { hour: 21, minute: 30 } as const satisfies Hhmm;
export const REMINDER_LEAD_MINUTES = -15 as const;
// why: 開催確定からリマインド予定時刻まで10分未満の場合は送らない（requirements/base.md §5.2）
export const REMINDER_SKIP_THRESHOLD_MINUTES = 10 as const;
// why: リマインド claim (reminder_sent_at を送信前に立てる) が長時間戻されない場合、
//   claim 保持プロセスが crash したとみなして startup/tick reconciler が reclaim する閾値。
//   claim → Discord 送信は通常ミリ秒オーダーのため、分単位の保持は異常と判断する。
// @see docs/adr/0024-reminder-dispatch.md, docs/adr/0033-startup-invariant-reconciler.md
export const REMINDER_CLAIM_STALENESS_MS = 5 * 60 * 1000;
// why: cron tick が 1 分 = 60 秒周期のため、これを超えると次 tick と競合するリスクがある。
//   10 秒を warn 閾値とし、長時間 tick を早期検知して noOverlap の有効性を評価できるようにする。
export const TICK_DURATION_WARN_MS = 10_000;
// why: メンバー数の SSoT は config.MEMBER_COUNT_EXPECTED (ADR-0012)
//   定義は env.ts（循環参照回避のため）。消費側は config.ts 経由で import する。
export { MEMBER_COUNT_EXPECTED } from "./env.js";

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
  if (hour === 24 && minute === 0) {
    return { hour, minute };
  }
  if (hour < 0 || hour > 23) {
    throw new Error(`Invalid HH:MM hour: ${value}`);
  }
  return { hour, minute };
};

// invariant: POSTPONE_DEADLINE は env.ts で "24:00" に固定済み。ここでは runtime tunable 形式へ正規化する。
export const POSTPONE_DEADLINE_HHMM = parseHhmm(env.POSTPONE_DEADLINE);
