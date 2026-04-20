// why: ask-session feature 固有の UI cosmetic (ADR-0026)
// ボタンの label / style をここに集約する。user-facing 文言（メッセージ本文）は src/messages.ts が担当。
import { ButtonStyle } from "discord.js";
import type { SlotKey } from "../../slot.js";

// --- Ask button labels ---
export const BUTTON_LABEL_ASK_T2200 = "22:00" as const;
export const BUTTON_LABEL_ASK_T2230 = "22:30" as const;
export const BUTTON_LABEL_ASK_T2300 = "23:00" as const;
export const BUTTON_LABEL_ASK_T2330 = "23:30" as const;
export const BUTTON_LABEL_ASK_ABSENT = "欠席" as const;

// --- Button styles ---
export const BUTTON_STYLE_ASK_TIME = ButtonStyle.Secondary;
export const BUTTON_STYLE_ASK_ABSENT = ButtonStyle.Danger;

/**
 * Ask button label map keyed by canonical SlotKey.
 *
 * @remarks
 * source-of-truth: SlotKey は src/slot.ts
 */
export const ASK_BUTTON_LABELS = {
  T2200: BUTTON_LABEL_ASK_T2200,
  T2230: BUTTON_LABEL_ASK_T2230,
  T2300: BUTTON_LABEL_ASK_T2300,
  T2330: BUTTON_LABEL_ASK_T2330
} as const satisfies Record<SlotKey, string>;

/**
 * Choice display label map keyed by DB choice value.
 *
 * @remarks
 * invariant: DB は SlotKey を verbatim で保存 + "ABSENT" の 5 値。
 *   SlotKey キーの `ASK_BUTTON_LABELS` をそのまま spread し ABSENT を追加することで、
 *   DB enum ↔ ラベルの SSoT を 1 本化する。
 * string index が必要なため Record<string, string> で型付け。
 */
export const CHOICE_LABEL_FOR_RESPONSE: Readonly<Record<string, string>> = {
  ...ASK_BUTTON_LABELS,
  ABSENT: BUTTON_LABEL_ASK_ABSENT
};
