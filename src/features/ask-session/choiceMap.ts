import type { AskCustomIdChoice } from "../../discord/shared/customId.js";

export type AskDbChoice = "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT";

export const ASK_CUSTOM_ID_TO_DB_CHOICE = {
  t2200: "T2200",
  t2230: "T2230",
  t2300: "T2300",
  t2330: "T2330",
  absent: "ABSENT"
} as const satisfies Record<AskCustomIdChoice, AskDbChoice>;
