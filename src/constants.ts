// why: UI cosmetic は constants に集約 (ADR-0013)
// ボタンの label / style をここに集約する。user-facing 文言（メッセージ本文）は src/messages.ts が担当。
import { ButtonStyle } from "discord.js";
import {
  dbChoiceFromSlotKey,
  type SlotKey
} from "./slot.js";

// --- Ask button labels ---
export const BUTTON_LABEL_ASK_T2200 = "22:00" as const;
export const BUTTON_LABEL_ASK_T2230 = "22:30" as const;
export const BUTTON_LABEL_ASK_T2300 = "23:00" as const;
export const BUTTON_LABEL_ASK_T2330 = "23:30" as const;
export const BUTTON_LABEL_ASK_ABSENT = "欠席" as const;

// --- Postpone button labels ---
export const BUTTON_LABEL_POSTPONE_OK = "翌日に順延で参加OK" as const;
export const BUTTON_LABEL_POSTPONE_NG = "NG" as const;

// --- Button styles ---
export const BUTTON_STYLE_ASK_TIME = ButtonStyle.Secondary;
export const BUTTON_STYLE_ASK_ABSENT = ButtonStyle.Danger;
export const BUTTON_STYLE_POSTPONE_OK = ButtonStyle.Primary;
export const BUTTON_STYLE_POSTPONE_NG = ButtonStyle.Secondary;

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
 * Choice display label map keyed by DB choice value (uppercase).
 *
 * @remarks
 * 回答状況の表示で DB の choice 値を人間可読ラベルに変換する。
 * string index が必要なため Record<string, string> で型付け。
 */
export const CHOICE_LABEL_FOR_RESPONSE: Readonly<Record<string, string>> = {
  [dbChoiceFromSlotKey("T2200")]: BUTTON_LABEL_ASK_T2200,
  [dbChoiceFromSlotKey("T2230")]: BUTTON_LABEL_ASK_T2230,
  [dbChoiceFromSlotKey("T2300")]: BUTTON_LABEL_ASK_T2300,
  [dbChoiceFromSlotKey("T2330")]: BUTTON_LABEL_ASK_T2330,
  ABSENT: BUTTON_LABEL_ASK_ABSENT,
};
