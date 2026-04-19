import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local" });

const discordId = z.string().regex(/^\d{17,20}$/);

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: discordId,
  DISCORD_CHANNEL_ID: discordId,
  MEMBER_USER_IDS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
    .pipe(z.array(discordId).length(4)),
  DATABASE_URL: z.string().url(),
  TZ: z.literal("Asia/Tokyo"),
  POSTPONE_DEADLINE: z.literal("24:00"),
  HEALTHCHECK_PING_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  )
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("\n");
  process.stderr.write(`Invalid environment variables:\n${details}\n`);
  process.exit(1);
}

export const env = result.data;
