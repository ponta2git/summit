import { z } from "zod";

// why: スロット値（22:00/22:30/23:00/23:30）のドメイン SSoT。
//   SlotKey（内部ドメイン値）と、それを wire にのせるときの 2 つの表現
//   （customId の choice トークン / DB の choice トークン）の対応を 1 ファイルで束ねる。
//   "スロットという概念の値変換" はここに集約する（ADR-0026）。
// boundary: 3-segment の interaction custom_id 構造そのものは src/discord/shared/customId.ts。
//   slot.ts は "slot 値" の変換だけを扱い、customId.ts は "custom_id 文字列全体" の codec を扱う。

// --- domain ---
export type SlotKey = "T2200" | "T2230" | "T2300" | "T2330";

export const SLOT_KEYS: readonly SlotKey[] = ["T2200", "T2230", "T2300", "T2330"] as const;

export const slotKeySchema = z.enum(SLOT_KEYS);

export const SLOT_TO_MINUTES: Record<SlotKey, { hour: number; minute: number }> = {
  T2200: { hour: 22, minute: 0 },
  T2230: { hour: 22, minute: 30 },
  T2300: { hour: 23, minute: 0 },
  T2330: { hour: 23, minute: 30 }
};

// --- customId wire ---
export const CUSTOM_ID_SLOT_CHOICES = ["t2200", "t2230", "t2300", "t2330"] as const;
export type CustomIdSlotChoice = (typeof CUSTOM_ID_SLOT_CHOICES)[number];

const CUSTOM_ID_TO_SLOT_KEY: Record<CustomIdSlotChoice, SlotKey> = {
  t2200: "T2200",
  t2230: "T2230",
  t2300: "T2300",
  t2330: "T2330"
};

const SLOT_KEY_TO_CUSTOM_ID: Record<SlotKey, CustomIdSlotChoice> = {
  T2200: "t2200",
  T2230: "t2230",
  T2300: "t2300",
  T2330: "t2330"
};

// invariant: wire format (customId, DB) は変更しない
export const slotKeyFromCustomIdChoice = (choice: CustomIdSlotChoice): SlotKey =>
  CUSTOM_ID_TO_SLOT_KEY[choice];

export const customIdChoiceFromSlotKey = (slotKey: SlotKey): CustomIdSlotChoice =>
  SLOT_KEY_TO_CUSTOM_ID[slotKey];

// --- DB wire ---
export type DbSlotChoice = SlotKey;

const SLOT_KEY_TO_DB_CHOICE: Record<SlotKey, DbSlotChoice> = {
  T2200: "T2200",
  T2230: "T2230",
  T2300: "T2300",
  T2330: "T2330"
};

const DB_CHOICE_TO_SLOT_KEY: Record<DbSlotChoice, SlotKey> = {
  T2200: "T2200",
  T2230: "T2230",
  T2300: "T2300",
  T2330: "T2330"
};

export const slotKeyFromDbChoice = (dbValue: DbSlotChoice): SlotKey =>
  DB_CHOICE_TO_SLOT_KEY[dbValue];

export const dbChoiceFromSlotKey = (slotKey: SlotKey): DbSlotChoice =>
  SLOT_KEY_TO_DB_CHOICE[slotKey];
