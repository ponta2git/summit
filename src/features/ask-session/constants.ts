// why: ask-session 固有の UI cosmetic。@see ADR-0026
//   user-facing 文言は src/messages.ts が担当。
import { ButtonStyle } from "discord.js";
import { SLOT_TO_LABEL, type SlotKey } from "../../slot.js";

export const BUTTON_LABEL_ASK_T2200 = SLOT_TO_LABEL.T2200;
export const BUTTON_LABEL_ASK_T2230 = SLOT_TO_LABEL.T2230;
export const BUTTON_LABEL_ASK_T2300 = SLOT_TO_LABEL.T2300;
export const BUTTON_LABEL_ASK_T2330 = SLOT_TO_LABEL.T2330;
export const BUTTON_LABEL_ASK_ABSENT = "欠席" as const;

export const BUTTON_STYLE_ASK_TIME = ButtonStyle.Secondary;
export const BUTTON_STYLE_ASK_ABSENT = ButtonStyle.Danger;

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
 * invariant: DB は SlotKey verbatim + `"ABSENT"`。`ASK_BUTTON_LABELS` を spread して ABSENT を追加し、
 *   DB enum ↔ ラベルの SSoT を一本化する。string index のため `Record<string, string>` で型付け。
 */
export const CHOICE_LABEL_FOR_RESPONSE: Readonly<Record<string, string>> = {
  ...ASK_BUTTON_LABELS,
  ABSENT: BUTTON_LABEL_ASK_ABSENT
};
