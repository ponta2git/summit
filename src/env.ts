import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local" });
// jst: 時刻計算・表示・ログ整形の全経路を Asia/Tokyo 固定にする。
//   env.ts の import 時点で確定させることで、後続 import (logger / time / drizzle) より先に反映される。
// @see docs/adr/0002-jst-fixed-time-handling.md
process.env.TZ ??= "Asia/Tokyo";

const discordId = z.string().regex(/^\d{17,20}$/);

// why: メンバー数の SSoT は config.MEMBER_COUNT_EXPECTED (ADR-0012)
// invariant: 固定 4 名運用（requirements/base.md §1）。env.MEMBER_USER_IDS はこの長さを満たす。
//   config.ts が env.ts に依存するため、循環参照回避のためこの位置で定義し config.ts から re-export する。
export const MEMBER_COUNT_EXPECTED = 4 as const;

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: discordId,
  DISCORD_CHANNEL_ID: discordId,
  // invariant: 固定 4 名運用。MEMBER_COUNT_EXPECTED を崩すと勝敗判定・通知対象・seed が破綻する。
  //   5 人目メンバーの扱いは仕様未定 (todo(ai)) のため、追加時は requirements/base.md の更新と合わせて変更する。
  MEMBER_USER_IDS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
    .pipe(z.array(discordId).length(MEMBER_COUNT_EXPECTED)),
  DATABASE_URL: z.string().url(),
  // jst: TZ は Asia/Tokyo 固定のみ許可する (DST なし、仕様上他地域での運用想定なし)。
  TZ: z.literal("Asia/Tokyo"),
  // jst: "24:00" は「候補日翌日 00:00 JST」のみとして解釈する。
  //   "25:00" 等の 24 超え表記、他の値は仕様未定義のため literal で固定。
  // @see requirements/base.md §5, docs/adr/0002-jst-fixed-time-handling.md
  POSTPONE_DEADLINE: z.literal("24:00"),
  HEALTHCHECK_PING_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  // why: 開発中に本番チャンネルへ投稿しても `<@id>` の push 通知を固定 4 名へ飛ばさないためのスイッチ。
  //   本番 invariant: 常時 OFF（未設定 = false）。true にすると本文から mention 行を除去し、
  //   加えて Client-level `allowedMentions: { parse: [] }` で保険をかける。
  // @see docs/adr/0011-dev-mention-suppression.md
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
  // why: env 不備は運用事故に直結するため起動時に即停止。遅延 throw は fly restart ループを誘発する。
  process.exit(1);
}

export const env = result.data;
