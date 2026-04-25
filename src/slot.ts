import { z } from "zod";

import { appConfig } from "./userConfig.js";

// source-of-truth: SlotKey は DB enum 値・time 計算・UI ラベル・customId wire が参照する正典。
//   customId の wire 表現は src/discord/shared/customId.ts。DB は SlotKey を verbatim に保存。
// @see ADR-0026

export type SlotKey = "T2200" | "T2230" | "T2300" | "T2330";

export const SLOT_KEYS: readonly SlotKey[] = ["T2200", "T2230", "T2300", "T2330"] as const;

export const slotKeySchema = z.enum(SLOT_KEYS);

const toMinutes = (value: string): { hour: number; minute: number } => {
  const [hourText, minuteText] = value.split(":");
  if (hourText === undefined || minuteText === undefined) {
    throw new Error(`Invalid slot HH:MM: ${value}`);
  }
  return { hour: Number(hourText), minute: Number(minuteText) };
};

export const SLOT_TO_LABEL: Record<SlotKey, string> = {
  T2200: appConfig.slots.T2200,
  T2230: appConfig.slots.T2230,
  T2300: appConfig.slots.T2300,
  T2330: appConfig.slots.T2330
};

export const SLOT_TO_MINUTES: Record<SlotKey, { hour: number; minute: number }> = {
  T2200: toMinutes(appConfig.slots.T2200),
  T2230: toMinutes(appConfig.slots.T2230),
  T2300: toMinutes(appConfig.slots.T2300),
  T2330: toMinutes(appConfig.slots.T2330)
};
