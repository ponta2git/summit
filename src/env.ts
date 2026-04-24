import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local" });
// jst: TZ を env.ts import 時点で固定し、後続 import (logger / time / drizzle) より先に反映。
// @see ADR-0002
process.env.TZ ??= "Asia/Tokyo";

const discordId = z.string().regex(/^\d{17,20}$/);

// why: メンバー数 SSoT → ADR-0012。config.ts が env.ts に依存するため循環回避でここに置き re-export する。
export const MEMBER_COUNT_EXPECTED = 4 as const;

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: discordId,
  DISCORD_CHANNEL_ID: discordId,
  // invariant: 固定 4 名運用。崩すと勝敗判定・通知対象・seed が破綻する → ADR-0012
  MEMBER_USER_IDS: z
    .string()
    // why: カンマ区切り文字列 → trim/空要素除去した配列に正規化してから length 検証する。
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
    .pipe(z.array(discordId).length(MEMBER_COUNT_EXPECTED)),
  MEMBER_DISPLAY_NAMES: z.preprocess(
    // why: 空文字・未設定は undefined 扱いにしたうえでカンマ区切りを配列化する。
    (value) => {
      if (value === "" || value === undefined) {
        return undefined;
      }
      if (typeof value !== "string") {
        return value;
      }
      return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    },
    z.array(z.string().min(1).max(32)).length(MEMBER_COUNT_EXPECTED).optional()
  ),
  DATABASE_URL: z.string().url(),
  // jst: Asia/Tokyo 固定のみ許可（DST なし、他地域運用想定なし）。
  TZ: z.literal("Asia/Tokyo"),
  // jst: "24:00" = 候補日翌日 00:00 JST の literal 固定。24 超え表記は parse 段階で弾く。
  // @see ADR-0002
  POSTPONE_DEADLINE: z.literal("24:00"),
  HEALTHCHECK_PING_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  // why: デプロイ追跡用。Fly の FLY_IMAGE_REF を優先、CI inject の GIT_SHA をフォールバックに使う。
  FLY_IMAGE_REF: z.string().optional(),
  GIT_SHA: z.string().optional(),
  // why: 開発時に `<@id>` の push 通知を抑止するスイッチ。本番 invariant は OFF → ADR-0011
  DEV_SUPPRESS_MENTIONS: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.stringbool().default(false)
  )
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("\n");
  process.stderr.write(`Invalid environment variables:\n${details}\n`);
  // why: env 不備は遅延 throw せず即停止する（fly restart ループ回避）。
  process.exit(1);
}

export const env = result.data;
