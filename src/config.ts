import { env } from "./env.js";

type Hhmm = Readonly<{ hour: number; minute: number }>;

// why: runtime tunables を config.ts に集約 (ADR-0013)
// invariant: cron 送信時刻は ADR-0007 に基づき金曜 08:00 JST を維持する。
export const CRON_ASK_SCHEDULE = "0 8 * * 5" as const;
export const CRON_DEADLINE_SCHEDULE = "30 21 * * 5" as const;
// jst: 土 00:00 JST = POSTPONE_DEADLINE="24:00" の「候補日翌日 00:00 JST」に対応する。
export const CRON_POSTPONE_DEADLINE_SCHEDULE = "0 0 * * 6" as const;
export const ASK_DEADLINE_HHMM = { hour: 21, minute: 30 } as const satisfies Hhmm;
export const REMINDER_LEAD_MINUTES = -15 as const;
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
