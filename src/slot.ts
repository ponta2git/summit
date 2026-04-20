import { z } from "zod";

// why: 候補時刻スロット（22:00/22:30/23:00/23:30）のドメイン SSoT。
//   SlotKey は DB enum 値・time 計算・UI ラベル・customId wire が参照する唯一の正典。
//   customId の lowercase wire 表現（t2200 等）は src/discord/shared/customId.ts が所有する。
//   DB は SlotKey を verbatim に保存するため DB ↔ SlotKey の変換関数は持たない。
// @see ADR-0026 cross-cutting wire format SSoT

export type SlotKey = "T2200" | "T2230" | "T2300" | "T2330";

export const SLOT_KEYS: readonly SlotKey[] = ["T2200", "T2230", "T2300", "T2330"] as const;

export const slotKeySchema = z.enum(SLOT_KEYS);

export const SLOT_TO_MINUTES: Record<SlotKey, { hour: number; minute: number }> = {
  T2200: { hour: 22, minute: 0 },
  T2230: { hour: 22, minute: 30 },
  T2300: { hour: 23, minute: 0 },
  T2330: { hour: 23, minute: 30 }
};
