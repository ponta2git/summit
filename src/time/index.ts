import { addDays, format, getDay, getISOWeek, getISOWeekYear, set } from "date-fns";
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
