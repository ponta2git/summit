// why: postpone-voting feature 固有の UI cosmetic @see ADR-0026
import { ButtonStyle } from "discord.js";

export const BUTTON_LABEL_POSTPONE_OK = "明日も募集OK" as const;
export const BUTTON_LABEL_POSTPONE_NG = "今週はお流れ" as const;

export const BUTTON_STYLE_POSTPONE_OK = ButtonStyle.Primary;
export const BUTTON_STYLE_POSTPONE_NG = ButtonStyle.Secondary;
