import { z } from "zod";
import { buildDiscordNotificationId, isNotificationSourceJobId, type DiscordResultNotification } from "@momo/db/notifications";
import { isIsoDate, isUtcMillisecondTimestamp } from "../time/index.ts";

export type NotificationInputCode = "invalid_input" | "unsupported_version" | "identity_conflict" | "payload_too_large";
export class NotificationInputError extends Error {
  readonly code: NotificationInputCode;
  constructor(code: NotificationInputCode) { super(code); this.name = "NotificationInputError"; this.code = code; }
}

const id = z.string().min(1).max(200);
const integer = z.number().int().nonnegative();
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19).refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const timestamp = z.string().refine(isUtcMillisecondTimestamp);
const date = z.string().refine(isIsoDate);
const identitySchema = z.object({
  notificationId: z.string().min(1).max(512),
  kind: z.enum(["ocr_completed", "analysis_completed"]),
  sourceJobId: z.string().refine(isNotificationSourceJobId)
});

export const readNotificationIdentity = (value: unknown): z.infer<typeof identitySchema> => {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) { throw new NotificationInputError("invalid_input"); }
  return parsed.data;
};

const rankSample = z.object({ matchCount: integer, averageRank: z.number().min(1).max(4).nullable() })
  .refine(sample => sample.matchCount === 0 ? sample.averageRank === null : sample.averageRank !== null);
const rankComparison = z.object({
  memberId: id, displayName: z.string(), before: rankSample.nullable(), after: rankSample,
  delta: z.number().min(-3).max(3).nullable(),
  comparison: z.enum(["comparable", "initial", "empty", "incomparable", "reused"])
}).refine(rank => {
  switch (rank.comparison) {
    case "comparable": return rank.before !== null && rank.before.matchCount > 0 && rank.after.matchCount > 0 && rank.delta !== null;
    case "initial": return rank.before === null && rank.delta === null;
    case "empty":
    case "incomparable": return rank.delta === null;
    case "reused": return rank.before?.matchCount === rank.after.matchCount
      && rank.before.averageRank === rank.after.averageRank && (rank.delta === 0 || rank.after.matchCount === 0);
  }
});
const ranks = z.tuple([rankComparison, rankComparison, rankComparison, rankComparison])
  .refine(values => new Set(values.map(value => value.memberId)).size === 4);
const analysisIdentity = z.object({
  artifactId: id, inputRevision: decimal, algorithmVersion: z.string(),
  artifactSchemaVersion: z.number().int().positive(), validationContractId: z.string().nullable()
});
const player = z.object({ memberId: id, displayName: z.string(), rank: z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4)
]), ginjiCount: integer });
const match = z.object({
  matchId: id, sourceRevision: decimal, heldEventId: id, heldDateIso: date, matchNoInEvent: z.number().int().positive(),
  playedAt: timestamp, mapName: z.string(), seasonId: id, seasonName: z.string(), ownerName: z.string(),
  players: z.tuple([player, player, player, player]), ginjiTotal: integer, note: z.string().nullable()
}).refine(value => new Set(value.players.map(p => p.memberId)).size === 4
  && new Set(value.players.map(p => p.rank)).size === 4
  && value.ginjiTotal === value.players.reduce((total, p) => total + p.ginjiCount, 0));
const envelope = {
  ...identitySchema.shape, occurredAt: timestamp, settingsGeneration: decimal
};

export const isSupportedResultNotification = (kind: string, schemaVersion: unknown): boolean =>
  (kind === "ocr_completed" && schemaVersion === 2) || (kind === "analysis_completed" && schemaVersion === 1);

/** Reject retired wire versions even when their immutable identity is retained. */
export const assertSupportedNotificationVersion = (value: unknown): void => {
  if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string"
    || !("schemaVersion" in value) || !isSupportedResultNotification(value.kind, value.schemaVersion)) {
    throw new NotificationInputError("unsupported_version");
  }
};
const ocrSchema = z.object({ ...envelope, schemaVersion: z.literal(2), kind: z.literal("ocr_completed"), data: z.object({
  submissionId: z.string().uuid(), matchDraftId: z.string().refine(isNotificationSourceJobId),
  context: z.object({
    gameTitleName: z.string().refine(value => [...value].length <= 201).nullable(), heldDateIso: date.nullable(), matchNoInEvent: z.number().int().positive().max(2_147_483_647).nullable()
  }).strict(),
  failures: z.array(z.object({
    screenType: z.enum(["total_assets", "revenue", "incident_log"]),
    reason: z.enum(["admission_failed", "admission_timeout", "ocr_failed", "ocr_timeout", "cancelled"])
  }).strict()).max(3).refine(values => new Set(values.map(value => value.screenType)).size === values.length)
}).strict() }).strict().refine(value => value.sourceJobId === `submission:${value.data.submissionId}`);
const analysisSchema = z.object({ ...envelope, schemaVersion: z.literal(1), kind: z.literal("analysis_completed"), data: z.object({
  gameTitleId: id, gameTitleName: z.string(), disposition: z.enum(["published", "reused"]),
  previousAnalysis: analysisIdentity.nullable(), currentAnalysis: analysisIdentity,
  matches: z.array(match), overall: ranks, seasons: z.array(z.object({ seasonId: id, seasonName: z.string(), ranks }))
}).refine(value => new Set(value.matches.map(m => m.matchId)).size === value.matches.length
  && new Set(value.seasons.map(season => season.seasonId)).size === value.seasons.length
  && (value.disposition !== "reused" || JSON.stringify(value.previousAnalysis) === JSON.stringify(value.currentAnalysis))) }).strict();
const notificationSchema = z.discriminatedUnion("kind", [ocrSchema, analysisSchema]);

/** Validate a new fixed payload; content conflicts are checked by the receipt command. */
export const validateNewNotification = (value: unknown): DiscordResultNotification => {
  assertSupportedNotificationVersion(value);
  const parsed = notificationSchema.safeParse(value);
  if (!parsed.success || parsed.data.notificationId !== buildDiscordNotificationId(parsed.data.kind, parsed.data.sourceJobId)) {
    throw new NotificationInputError("invalid_input");
  }
  return parsed.data;
};
