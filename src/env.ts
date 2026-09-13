import { envSchema } from "./envSchema.ts";

// jst: 起動時の値だけを読む。local file は package command が明示的に注入する。
process.env["TZ"] ??= "Asia/Tokyo";

export const MEMBER_COUNT_EXPECTED = 4 as const;

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
