// why: custom_id の 3-segment codec と slot の wire 表現（lowercase）をここで所有する。
//   SlotKey の意味論は src/slot.ts、DB は SlotKey を verbatim 保存するため DB 側の wire 変換は不要。
// @see docs/adr/0016-customid-codec-hmac-rejected.md
import { z } from "zod";
import type { SlotKey } from "../../slot.js";

// invariant: SlotKey と 1:1 対応する lowercase wire 表現。
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

export const slotKeyFromCustomIdChoice = (choice: CustomIdSlotChoice): SlotKey =>
  CUSTOM_ID_TO_SLOT_KEY[choice];

export const customIdChoiceFromSlotKey = (slotKey: SlotKey): CustomIdSlotChoice =>
  SLOT_KEY_TO_CUSTOM_ID[slotKey];

const askCustomIdChoiceSchema = z.union([
  z.enum(CUSTOM_ID_SLOT_CHOICES),
  z.literal("absent")
]);

const askCustomIdSpecSchema = z.object({
  kind: z.literal("ask"),
  sessionId: z.uuid(),
  choice: askCustomIdChoiceSchema
});

const postponeCustomIdSpecSchema = z.object({
  kind: z.literal("postpone"),
  sessionId: z.uuid(),
  choice: z.enum(["ok", "ng"])
});

const customIdSpecSchema = z.discriminatedUnion("kind", [
  askCustomIdSpecSchema,
  postponeCustomIdSpecSchema
]);

const customIdCodecSchema = z
  .string()
  .transform((raw, ctx) => {
    const segments = raw.split(":");
    if (segments.length !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "custom_id must have exactly 3 segments."
      });
      return z.NEVER;
    }
    const [kind, sessionId, choice] = segments;
    return { kind, sessionId, choice };
  })
  .pipe(customIdSpecSchema);

export type CustomIdSpec = z.infer<typeof customIdSpecSchema>;
export type AskCustomIdChoice = z.infer<typeof askCustomIdSpecSchema>["choice"];
export type PostponeCustomIdChoice = z.infer<typeof postponeCustomIdSpecSchema>["choice"];

export const parseCustomId = (raw: string): z.ZodSafeParseResult<CustomIdSpec> =>
  customIdCodecSchema.safeParse(raw);

// invariant: buildCustomId ∘ parseCustomId = identity on valid inputs
export const buildCustomId = (spec: CustomIdSpec): string =>
  `${spec.kind}:${spec.sessionId}:${spec.choice}`;

// why: cancel_week は session を持たない独立フロー。nonce で stale dialog を識別し、
//   ask/postpone codec と衝突させないため別 schema にする。
// @see docs/adr/0023-cancel-week-command-flow.md
const cancelWeekCustomIdSpecSchema = z.object({
  kind: z.literal("cancel_week"),
  nonce: z.uuid(),
  choice: z.enum(["confirm", "abort"])
});

const cancelWeekCodecSchema = z
  .string()
  .transform((raw, ctx) => {
    const segments = raw.split(":");
    if (segments.length !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "cancel_week custom_id must have exactly 3 segments."
      });
      return z.NEVER;
    }
    const [kind, nonce, choice] = segments;
    return { kind, nonce, choice };
  })
  .pipe(cancelWeekCustomIdSpecSchema);

export type CancelWeekCustomIdSpec = z.infer<typeof cancelWeekCustomIdSpecSchema>;
export type CancelWeekCustomIdChoice = CancelWeekCustomIdSpec["choice"];

export const CANCEL_WEEK_CUSTOM_ID_PREFIX = "cancel_week:" as const;

export const parseCancelWeekCustomId = (
  raw: string
): z.ZodSafeParseResult<CancelWeekCustomIdSpec> => cancelWeekCodecSchema.safeParse(raw);

// invariant: buildCancelWeekCustomId ∘ parseCancelWeekCustomId = identity on valid inputs
export const buildCancelWeekCustomId = (spec: CancelWeekCustomIdSpec): string =>
  `${spec.kind}:${spec.nonce}:${spec.choice}`;
