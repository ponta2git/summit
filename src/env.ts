import { envSchema } from "./envSchema.ts";
import { writeSync } from "node:fs";
import { reportSafely } from "./runtime/diagnostics.ts";

// jst: 起動時の値だけを読む。local file は package command が明示的に注入する。
process.env["TZ"] ??= "Asia/Tokyo";

export const MEMBER_COUNT_EXPECTED = 4 as const;

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("\n");
  reportSafely(() => { writeSync(process.stderr.fd, `Invalid environment variables:\n${details}\n`); });
  // why: 同期stderrの後、設定不備で依存moduleを評価しない。bootstrapのimport契約変更時に再評価する。
  // skipcq: JS-0263
  process.exit(1);
}

export const env = result.data;
