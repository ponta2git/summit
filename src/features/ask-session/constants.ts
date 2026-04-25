// why: ask-session 固有の UI cosmetic。@see ADR-0026
//   user-facing 文言は src/messages.ts が担当。
import { ButtonStyle } from "discord.js";
import { SLOT_TO_LABEL, type SlotKey } from "../../slot.js";

export type AskResponseChoice = SlotKey | "ABSENT";

export const BUTTON_LABEL_ASK_T2200 = SLOT_TO_LABEL.T2200;
export const BUTTON_LABEL_ASK_T2230 = SLOT_TO_LABEL.T2230;
export const BUTTON_LABEL_ASK_T2300 = SLOT_TO_LABEL.T2300;
export const BUTTON_LABEL_ASK_T2330 = SLOT_TO_LABEL.T2330;
export const BUTTON_LABEL_ASK_ABSENT = "今回は欠席" as const;

export const BUTTON_STYLE_ASK_TIME = ButtonStyle.Secondary;
export const BUTTON_STYLE_ASK_ABSENT = ButtonStyle.Danger;

export const SLOT_KEY_TO_ASK_BUTTON_LABEL = {
  T2200: BUTTON_LABEL_ASK_T2200,
  T2230: BUTTON_LABEL_ASK_T2230,
  T2300: BUTTON_LABEL_ASK_T2300,
  T2330: BUTTON_LABEL_ASK_T2330
} as const satisfies Record<SlotKey, string>;

/**
 * Choice display label map keyed by ask-session DB choice value.
 *
 * @remarks
 * invariant: DB は SlotKey verbatim + `"ABSENT"`。`SLOT_KEY_TO_ASK_BUTTON_LABEL` を spread して
 *   ABSENT を追加し、DB enum ↔ ラベルの SSoT を一本化する。
 */
export const ASK_RESPONSE_CHOICE_TO_LABEL = {
  ...SLOT_KEY_TO_ASK_BUTTON_LABEL,
  ABSENT: BUTTON_LABEL_ASK_ABSENT
} as const satisfies Record<AskResponseChoice, string>;
