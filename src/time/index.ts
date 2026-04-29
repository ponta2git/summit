import {
  addDays,
  addMinutes,
  format,
  getISOWeek,
  getISOWeekYear,
  set,
  startOfDay
} from "date-fns";
import { ja } from "date-fns/locale";
import {
  ASK_DEADLINE_HHMM,
  REMINDER_LEAD_MINUTES
} from "../config.js";
import {
  SLOT_KEYS,
  SLOT_TO_LABEL,
  SLOT_TO_MINUTES,
  type SlotKey
} from "../slot.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

/**
 * Returns the ISO-week key in `YYYY-Www` form for a given instant.
 *
 * @remarks
 * iso-week: 金曜と翌土曜 (順延) は同一週キーを共有。年跨ぎで暦年と ISO year が乖離するため
 * `getISOWeekYear` と `getISOWeek` を必ず併用する (自作禁止)。
 */
export const isoWeekKey = (value: Date): string => {
  const isoYear = getISOWeekYear(value);
  const isoWeek = String(getISOWeek(value)).padStart(2, "0");
  return `${isoYear}-W${isoWeek}`;
};

// why: 送信時点の now をそのまま候補日とする恒等関数。日付境界を跨ぐ操作が必要になった場合のみ拡張。
// @see ADR-0007
export const candidateDateForAsk = (now: Date): Date => now;

export const formatCandidateJa = (value: Date): string =>
  `${format(value, "yyyy-MM-dd(E)", { locale: ja })} ${SLOT_TO_LABEL.T2200} 以降`;

export const formatCandidateDateIso = (value: Date): string =>
  format(value, "yyyy-MM-dd");

export const ASK_TIME_CHOICES = SLOT_KEYS;
export type AskTimeChoice = SlotKey;

/**
 * Parses a `YYYY-MM-DD` string as the JST midnight of that date.
 *
 * @remarks
 * jst: `process.env.TZ=Asia/Tokyo` 前提。UTC として解釈すると candidateDate / deadlineAt が
 * 9 時間ズレるため必ずこの関数経由で復元する。
 * @throws if `value` does not match `YYYY-MM-DD`.
 */
export const parseCandidateDateIso = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {throw new Error(`Invalid candidate date: ${value}`);}
  const [, y, m, d] = match;
  return set(startOfDay(new Date(Number(y), Number(m) - 1, Number(d))), {
    hours: 0,
    minutes: 0,
    seconds: 0,
    milliseconds: 0
  });
};

/**
 * Computes the asking-deadline timestamp for a candidate date.
 *
 * @remarks
 * jst: 締切は候補日当日の `ASK_DEADLINE_HHMM` (src/config.ts)。
 * @see requirements/base.md §4
 */
export const deadlineFor = (candidateDate: Date): Date =>
  set(startOfDay(candidateDate), {
    hours: ASK_DEADLINE_HHMM.hour,
    minutes: ASK_DEADLINE_HHMM.minute,
    seconds: 0,
    milliseconds: 0
  });

/**
 * Computes the postpone-vote deadline for a candidate date.
 *
 * @remarks
 * jst: user config の postponeDeadline 表記に対応する (src/config.ts / src/userConfig.ts)。
 * @see requirements/base.md §6
 */
export const postponeDeadlineFor = (candidateDate: Date): Date =>
  startOfDay(addDays(candidateDate, 1));

export const saturdayCandidateFrom = (fridayCandidate: Date): Date =>
  startOfDay(addDays(fridayCandidate, 1));

const CHOICE_RANK: Record<AskTimeChoice, number> = {
  T2200: 0,
  T2230: 1,
  T2300: 2,
  T2330: 3
};

/**
 * Pick the latest time slot from a set of member choices.
 *
 * @remarks
 * source-of-truth: 全員が選べる時刻のうち最も遅いスロットを採用する集約規則。
 * 入力順に依存しないよう `CHOICE_RANK` で決定する。
 */
export const latestChoice = (
  choices: readonly AskTimeChoice[]
): AskTimeChoice | undefined => {
  if (choices.length === 0) {return undefined;}
  return [...choices].sort((a, b) => CHOICE_RANK[b] - CHOICE_RANK[a])[0];
};

/**
 * Decided start instant derived from the members' latest alive choices.
 *
 * @remarks
 * 全員が合意できる最も遅いスロットを採用する。`choices` が空なら `undefined`。
 */
export const decidedStartAt = (
  candidateDate: Date,
  choices: readonly AskTimeChoice[]
): Date | undefined => {
  const latest = latestChoice(choices);
  if (!latest) {return undefined;}
  const slot = SLOT_TO_MINUTES[latest];
  return set(startOfDay(candidateDate), {
    hours: slot.hour,
    minutes: slot.minute,
    seconds: 0,
    milliseconds: 0
  });
};

export const reminderAtFor = (startAt: Date): Date =>
  addMinutes(startAt, REMINDER_LEAD_MINUTES);

// why: `new Date()` を src/time/ 外で直接生成しないルールに従い、相対オフセット計算も time 層に集約する。
export const addMs = (now: Date, ms: number): Date =>
  new Date(now.getTime() + ms);

// why: `new Date()` を src/time/ 外で直接生成しないルールに従い、相対オフセット計算も time 層に集約する。
export const subMs = (now: Date, ms: number): Date =>
  new Date(now.getTime() - ms);

export const parseTimestamp = (value: string): Date | null => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) { return null; }
  return parsed;
};

export const unixEpoch = (): Date => new Date(0);
