import { z } from "zod";
import { buildDiscordNotificationId, isNotificationSourceJobId, type DiscordResultNotification } from "@momo/db/notifications";
import { isIsoDate, isUtcMillisecondTimestamp } from "../time/index.ts";
import {
  RESULT_NOTIFICATION_MAX_DISPLAY_NAME_CODEPOINTS, RESULT_NOTIFICATION_MAX_MATCHES,
  RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS, RESULT_NOTIFICATION_MAX_NOTE_CODEPOINTS,
  RESULT_NOTIFICATION_MAX_SEASONS
} from "../notifications/config.ts";
import { NotificationInputError } from "./notificationInput.ts";

export { NotificationInputError } from "./notificationInput.ts";

/** Limit allocation before JSON.parse; quoted text and escaped delimiters consume no structural budget. */
export const parseNotificationJson = (raw: string): unknown => {
  let quoted = false;
  let depth = 0;
  let structures = 0;
  // why: 有効 payload の固定 field 名に対して十分な余裕を持ち、巨大メモの文字数は制限しない。
  for (let offset = 0; offset < raw.length; offset += 1) {
    const character = raw.charCodeAt(offset);
    if (quoted) {
      if (character === 92) { offset += 1; }
      else if (character === 34) { quoted = false; }
      continue;
    }
    if (character === 34) { quoted = true; }
    else if (character === 123 || character === 91) { depth += 1; structures += 1; }
    else if (character === 125 || character === 93) { depth -= 1; }
    else if (character === 44) { structures += 1; }
    if (depth > 64 || structures > 1_000_000) { throw new NotificationInputError("payload_too_large"); }
  }
  try { return JSON.parse(raw); } catch { throw new NotificationInputError("invalid_input"); }
};

// why: z.array(item) は不正な全要素の issues を保持する。境界では最初の不正だけで拒否する。
const collection = <T>(schema: z.ZodType<T>, maxLength?: number): z.ZodType<T[]> => {
  const input = z.array(z.unknown());
  return (maxLength === undefined ? input : input.max(maxLength)).transform((values, ctx) => {
    const parsed: T[] = [];
    for (const value of values) {
      const item = schema.safeParse(value);
      if (!item.success) { ctx.addIssue({ code: "custom", message: "Invalid collection item" }); return z.NEVER; }
      parsed.push(item.data);
    }
    return parsed;
  });
};

const id = z.string().min(1).max(200);
const integer = z.number().int().nonnegative();
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19).refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const timestamp = z.string().refine(isUtcMillisecondTimestamp);
const date = z.string().refine(isIsoDate);
const withinCodePointLimit = (value: string, limit: number): boolean => {
  let count = 0;
  const points = value[Symbol.iterator]();
  while (!points.next().done) { if (++count > limit) { return false; } }
  return true;
};
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
    gameTitleName: z.string().refine(value => withinCodePointLimit(value, 201)).nullable(), heldDateIso: date.nullable(), matchNoInEvent: z.number().int().positive().max(2_147_483_647).nullable()
  }).strict(),
  failures: collection(z.object({
    screenType: z.enum(["total_assets", "revenue", "incident_log"]),
    reason: z.enum(["admission_failed", "admission_timeout", "ocr_failed", "ocr_timeout", "cancelled"])
  }).strict(), 3).refine(values => new Set(values.map(value => value.screenType)).size === values.length)
}).strict() }).strict().refine(value => value.sourceJobId === `submission:${value.data.submissionId}`);
const analysisSchema = z.object({ ...envelope, schemaVersion: z.literal(1), kind: z.literal("analysis_completed"), data: z.object({
  gameTitleId: id, gameTitleName: z.string(), disposition: z.enum(["published", "reused"]),
  previousAnalysis: analysisIdentity.nullable(), currentAnalysis: analysisIdentity,
  matches: collection(match), overall: ranks, seasons: collection(z.object({ seasonId: id, seasonName: z.string(), ranks }))
}).refine(value => new Set(value.matches.map(m => m.matchId)).size === value.matches.length
  && new Set(value.seasons.map(season => season.seasonId)).size === value.seasons.length
  && (value.disposition !== "reused" || JSON.stringify(value.previousAnalysis) === JSON.stringify(value.currentAnalysis))) }).strict();
const notificationSchema = z.discriminatedUnion("kind", [ocrSchema, analysisSchema]);

/** Preserve the payload contract under which an existing notification was accepted. */
export const validateStoredNotification = (value: unknown): DiscordResultNotification => {
  assertSupportedNotificationVersion(value);
  const parsed = notificationSchema.safeParse(value);
  if (!parsed.success || parsed.data.notificationId !== buildDiscordNotificationId(parsed.data.kind, parsed.data.sourceJobId)) {
    throw new NotificationInputError("invalid_input");
  }
  return parsed.data;
};

/** Validate new admission limits without applying them to retained notifications. */
export const validateNewNotification = (value: unknown): DiscordResultNotification => {
  assertSupportedNotificationVersion(value);
  // why: 配列の複製と item 検証を始める前に、新規受付の件数予算を適用する。
  if (typeof value === "object" && value !== null && "kind" in value && value.kind === "analysis_completed"
    && "data" in value && typeof value.data === "object" && value.data !== null) {
    for (const [key, limit] of [["matches", RESULT_NOTIFICATION_MAX_MATCHES], ["seasons", RESULT_NOTIFICATION_MAX_SEASONS]] as const) {
      const values = key in value.data ? Reflect.get(value.data, key) : undefined;
      if (Array.isArray(values) && values.length > limit) { throw new NotificationInputError("payload_too_large"); }
    }
  }
  const notification = validateStoredNotification(value);
  if (notification.kind === "analysis_completed") {
    const bounded = (text: string, maximum: number): void => {
      if (!withinCodePointLimit(text, maximum)) { throw new NotificationInputError("payload_too_large"); }
    };
    const displayNames = (values: readonly { readonly displayName: string }[]): void => {
      for (const item of values) { bounded(item.displayName, RESULT_NOTIFICATION_MAX_DISPLAY_NAME_CODEPOINTS); }
    };
    const { data } = notification;
    bounded(data.gameTitleName, RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS);
    displayNames(data.overall);
    for (const season of data.seasons) {
      bounded(season.seasonName, RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS);
      displayNames(season.ranks);
    }
    for (const item of data.matches) {
      bounded(item.mapName, RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS);
      bounded(item.seasonName, RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS);
      bounded(item.ownerName, RESULT_NOTIFICATION_MAX_DISPLAY_NAME_CODEPOINTS);
      displayNames(item.players);
      if (item.note !== null) { bounded(item.note, RESULT_NOTIFICATION_MAX_NOTE_CODEPOINTS); }
    }
  }
  return notification;
};
