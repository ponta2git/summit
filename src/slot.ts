import { z } from "zod";

export type SlotKey = "T2200" | "T2230" | "T2300" | "T2330";

// source-of-truth: wire format (customId / DB choice) と label mapping の SSoT。cross-cutting なため src/ 直下に配置（ADR-0026）。
export const SLOT_KEYS: readonly SlotKey[] = ["T2200", "T2230", "T2300", "T2330"] as const;

export const slotKeySchema = z.enum(SLOT_KEYS);

export const SLOT_TO_MINUTES: Record<SlotKey, { hour: number; minute: number }> = {
  T2200: { hour: 22, minute: 0 },
  T2230: { hour: 22, minute: 30 },
  T2300: { hour: 23, minute: 0 },
  T2330: { hour: 23, minute: 30 }
};

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

// invariant: wire format (customId, DB) は変更しない
export const slotKeyFromCustomIdChoice = (choice: CustomIdSlotChoice): SlotKey =>
  CUSTOM_ID_TO_SLOT_KEY[choice];

export const customIdChoiceFromSlotKey = (slotKey: SlotKey): CustomIdSlotChoice =>
  SLOT_KEY_TO_CUSTOM_ID[slotKey];

export const slotKeyFromDbChoice = (dbValue: DbSlotChoice): SlotKey =>
  DB_CHOICE_TO_SLOT_KEY[dbValue];

export const dbChoiceFromSlotKey = (slotKey: SlotKey): DbSlotChoice =>
  SLOT_KEY_TO_DB_CHOICE[slotKey];
