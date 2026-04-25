import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local" });
// jst: TZ を env.ts import 時点で固定し、後続 import (logger / time / drizzle) より先に反映。
// @see ADR-0002
process.env["TZ"] ??= "Asia/Tokyo";

// why: メンバー数 SSoT → ADR-0012。config.ts が env.ts に依存するため循環回避でここに置き re-export する。
export const MEMBER_COUNT_EXPECTED = 4 as const;

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  SUMMIT_CONFIG_YAML: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1)
  ),
  // jst: Asia/Tokyo 固定のみ許可（DST なし、他地域運用想定なし）。
  TZ: z.literal("Asia/Tokyo"),
  HEALTHCHECK_PING_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  // why: デプロイ追跡用。Fly の FLY_IMAGE_REF を優先、CI inject の GIT_SHA をフォールバックに使う。
  FLY_IMAGE_REF: z.string().optional(),
  GIT_SHA: z.string().optional()
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
