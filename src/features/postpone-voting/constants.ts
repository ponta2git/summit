// why: postpone-voting feature 固有の UI cosmetic (ADR-0026)
import { ButtonStyle } from "discord.js";

// --- Postpone button labels ---
export const BUTTON_LABEL_POSTPONE_OK = "翌日に順延で参加OK" as const;
export const BUTTON_LABEL_POSTPONE_NG = "NG" as const;

// --- Button styles ---
export const BUTTON_STYLE_POSTPONE_OK = ButtonStyle.Primary;
export const BUTTON_STYLE_POSTPONE_NG = ButtonStyle.Secondary;
