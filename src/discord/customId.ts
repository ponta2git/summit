import { z } from "zod";
import { CUSTOM_ID_SLOT_CHOICES } from "../domain/index.js";

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

// why: customId codec 統一 (ADR-0016)
export const parseCustomId = (raw: string): z.ZodSafeParseResult<CustomIdSpec> =>
  customIdCodecSchema.safeParse(raw);

// invariant: buildCustomId ∘ parseCustomId = identity on valid inputs
export const buildCustomId = (spec: CustomIdSpec): string =>
  `${spec.kind}:${spec.sessionId}:${spec.choice}`;
