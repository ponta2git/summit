import { z } from "zod";

// source-of-truth: SlotKey は DB enum 値・time 計算・UI ラベル・customId wire が参照する正典。
//   customId の wire 表現は src/discord/shared/customId.ts。DB は SlotKey を verbatim に保存。
// @see ADR-0026

export type SlotKey = "T2200" | "T2230" | "T2300" | "T2330";

export const SLOT_KEYS: readonly SlotKey[] = ["T2200", "T2230", "T2300", "T2330"] as const;

export const slotKeySchema = z.enum(SLOT_KEYS);

export const SLOT_TO_MINUTES: Record<SlotKey, { hour: number; minute: number }> = {
  T2200: { hour: 22, minute: 0 },
  T2230: { hour: 22, minute: 30 },
  T2300: { hour: 23, minute: 0 },
  T2330: { hour: 23, minute: 30 }
};
