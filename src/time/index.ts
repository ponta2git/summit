import {
  addDays,
  addMinutes,
  format,
  getDay,
  getISOWeek,
  getISOWeekYear,
  set,
  startOfDay
} from "date-fns";
import { ja } from "date-fns/locale";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

export const nowJst = (clock: Clock = systemClock): Date => clock.now();

export const isoWeekKey = (value: Date): string => {
  const isoYear = getISOWeekYear(value);
  const isoWeek = String(getISOWeek(value)).padStart(2, "0");
  return `${isoYear}-W${isoWeek}`;
};

export const candidateDateForSend = (now: Date): Date => now;

export const formatCandidateJa = (value: Date): string =>
  `${format(value, "yyyy-MM-dd(E)", { locale: ja })} 22:00 以降`;

export const formatCandidateDateIso = (value: Date): string =>
  format(value, "yyyy-MM-dd");

export const nextFriday18JST = (now: Date): Date => {
  const day = getDay(now);
  const daysUntilFriday = (5 - day + 7) % 7;
  return set(addDays(now, daysUntilFriday), {
    hours: 18,
    minutes: 0,
    seconds: 0,
    milliseconds: 0
  });
};

export const ASK_TIME_CHOICES = ["T2200", "T2230", "T2300", "T2330"] as const;
export type AskTimeChoice = (typeof ASK_TIME_CHOICES)[number];

const SLOT_MINUTES: Record<AskTimeChoice, { h: number; m: number }> = {
  T2200: { h: 22, m: 0 },
  T2230: { h: 22, m: 30 },
  T2300: { h: 23, m: 0 },
  T2330: { h: 23, m: 30 }
};

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

export const deadlineFor = (candidateDate: Date): Date =>
  set(startOfDay(candidateDate), {
    hours: 21,
    minutes: 30,
    seconds: 0,
    milliseconds: 0
  });

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

export const decidedStartAt = (
  candidateDate: Date,
  choices: readonly AskTimeChoice[]
): Date | undefined => {
  const latest = latestChoice(choices);
  if (!latest) {return undefined;}
  const slot = SLOT_MINUTES[latest];
  return set(startOfDay(candidateDate), {
    hours: slot.h,
    minutes: slot.m,
    seconds: 0,
    milliseconds: 0
  });
};

export const reminderAtFor = (startAt: Date): Date => addMinutes(startAt, -15);
