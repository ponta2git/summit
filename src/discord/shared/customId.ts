import { z } from "zod";
import { CUSTOM_ID_SLOT_CHOICES } from "../../slot.js";

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

// why: customId codec 統一 (ADR-0016)
export const parseCustomId = (raw: string): z.ZodSafeParseResult<CustomIdSpec> =>
  customIdCodecSchema.safeParse(raw);

// invariant: buildCustomId ∘ parseCustomId = identity on valid inputs
export const buildCustomId = (spec: CustomIdSpec): string =>
  `${spec.kind}:${spec.sessionId}:${spec.choice}`;

// why: cancel_week の確認ダイアログは session を持たない独立フロー。中段に nonce を置いて
//   「stale dialog を踏み直した」ケースを識別しつつ、既存 ask/postpone の codec と衝突しないよう
//   別 codec として持つ。3 セグメント形式は踏襲し、prefix で dispatcher 側が分岐する。
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
