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
 * @param value - Date whose ISO week representation is requested.
 * @returns ISO-week key such as `2026-W17`.
 *
 * @remarks
 * 金曜 Session と翌土曜の順延 Session は同一週キーを共有する。年跨ぎで暦年と ISO year が
 * 乖離するため、`getISOWeekYear` と `getISOWeek` を必ず併用すること。
 */
export const isoWeekKey = (value: Date): string => {
  // iso-week: 年跨ぎ (12/31 金 と 1/1 土 が同じ ISO week に属する等) で暦年と ISO year が乖離するため、
  //   getISOWeekYear と getISOWeek を必ず併用する。getFullYear で自作すると YYYY-Www がズレる。
  const isoYear = getISOWeekYear(value);
  const isoWeek = String(getISOWeek(value)).padStart(2, "0");
  return `${isoYear}-W${isoWeek}`;
};

// why: 「送信時点の日付をそのまま候補日とする」仕様の恒等関数。
//   cron (金 08:00 JST) でも /ask コマンドでも now を候補日として扱う。
//   日付境界を跨ぐ操作 (翌日候補化等) が必要になった場合のみここに集約する。
// @see docs/adr/0007-ask-command-always-available-and-08-jst-cron.md
export const candidateDateForAsk = (now: Date): Date => now;

export const formatCandidateJa = (value: Date): string =>
  `${format(value, "yyyy-MM-dd(E)", { locale: ja })} 22:00 以降`;

export const formatCandidateDateIso = (value: Date): string =>
  format(value, "yyyy-MM-dd");

export const ASK_TIME_CHOICES = SLOT_KEYS;
export type AskTimeChoice = SlotKey;

/**
 * Parses a `YYYY-MM-DD` string as the JST midnight of that date.
 *
 * @param value - ISO-like date string (no time component).
 * @returns JST 00:00 of the specified date.
 * @throws Error if `value` does not match `YYYY-MM-DD`.
 *
 * @remarks
 * `process.env.TZ=Asia/Tokyo` 前提。UTC として解釈すると締切や候補日が 9 時間ズレるため、
 * 必ずこの関数経由で復元する。
 */
export const parseCandidateDateIso = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {throw new Error(`Invalid candidate date: ${value}`);}
  const [, y, m, d] = match;
  // jst: process.env.TZ=Asia/Tokyo 前提で new Date(y,m-1,d) を JST 0:00 として生成する。
  //   UTC ベースで解釈すると candidateDate と deadlineAt が 9 時間ズレるため TZ 固定が必須。
  return set(startOfDay(new Date(Number(y), Number(m) - 1, Number(d))), {
    hours: 0,
    minutes: 0,
    seconds: 0,
    milliseconds: 0
  });
};

/**
 * Computes the asking-deadline timestamp (21:30 JST) for a candidate date.
 *
 * @param candidateDate - Date to ask about (typically JST 00:00).
 * @returns Deadline instant at 21:30 JST on the same date.
 *
 * @remarks
 * 送信時刻 (金 08:00 JST) や順延期限 (候補日翌日 00:00 JST) とは別物。
 * 仕様は `requirements/base.md` §4 を参照。
 */
export const deadlineFor = (candidateDate: Date): Date =>
  // jst: 締切は候補日当日 21:30 JST。送信時刻 (金 08:00) や順延 (候補日翌日 00:00) とは別物。
  // @see requirements/base.md §4
  set(startOfDay(candidateDate), {
    hours: ASK_DEADLINE_HHMM.hour,
    minutes: ASK_DEADLINE_HHMM.minute,
    seconds: 0,
    milliseconds: 0
  });

/**
 * Computes the postpone-vote deadline for a given candidate date.
 * @returns The instant at 00:00 JST of the day **after** `candidateDate`.
 * @remarks
 * 候補日翌日 00:00 JST の意。`POSTPONE_DEADLINE="24:00"` 表記のアプリ解釈に一致する。
 * @see requirements/base.md §6 / POSTPONE_DEADLINE
 */
export const postponeDeadlineFor = (candidateDate: Date): Date =>
  // jst: `24:00` は候補日の翌日 00:00 JST として扱う（将来 tunable 化する場合も time 層で正規化する）。
  startOfDay(addDays(candidateDate, 1));

/**
 * Given the Friday candidate date, compute the Saturday postponed-session candidate date.
 * @returns `candidateDate + 1 day` at 00:00 JST.
 */
export const saturdayCandidateFrom = (fridayCandidate: Date): Date =>
  // jst: 順延先は常に翌日の土曜 00:00 JST（年跨ぎでも +1 day で扱う）。
  startOfDay(addDays(fridayCandidate, 1));

const CHOICE_RANK: Record<AskTimeChoice, number> = {
  T2200: 0,
  T2230: 1,
  T2300: 2,
  T2330: 3
};

export const latestChoice = (
  choices: readonly AskTimeChoice[]
): AskTimeChoice | undefined => {
  if (choices.length === 0) {return undefined;}
  return [...choices].sort((a, b) => CHOICE_RANK[b] - CHOICE_RANK[a])[0];
};

/**
 * Computes the decided start instant for a session given the members' latest choices.
 *
 * @param candidateDate - Candidate date (JST 00:00).
 * @param choices - Members' time-slot choices that are still alive.
 * @returns The start instant for the latest chosen slot, or `undefined` if `choices` is empty.
 *
 * @remarks
 * 「全員が合意できる最も遅いスロット」に相当する。`latestChoice` の戻り値がそのまま採用される。
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
