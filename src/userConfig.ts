import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { env } from "./env.js";

const discordId = z.string().regex(/^\d{17,20}$/);
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const memberSchema = z.object({
  userId: discordId,
  displayName: z.string().min(1).max(32)
});

export const userConfigSchema = z.object({
  discord: z.object({
    guildId: discordId,
    channelId: discordId
  }),
  members: z.array(memberSchema).length(4),
  schedule: z.object({
    askTime: hhmm,
    answerDeadline: hhmm,
    postponeDeadline: z.literal("24:00"),
    reminderLeadMinutes: z.number().int().positive()
  }),
  slots: z.object({
    T2200: z.literal("22:00"),
    T2230: z.literal("22:30"),
    T2300: z.literal("23:00"),
    T2330: z.literal("23:30")
  }),
  dev: z.object({
    suppressMentions: z.boolean().default(false)
  }).default({ suppressMentions: false })
});

export type UserConfig = z.infer<typeof userConfigSchema>;

export interface AppConfig extends UserConfig {
  readonly memberUserIds: readonly string[];
  readonly memberDisplayNames: readonly string[];
}

export const parseUserConfigInput = (input: unknown): UserConfig =>
  userConfigSchema.parse(input);

const formatConfigIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("\n");

const parseUserConfigYaml = (value: string): unknown => parseYaml(value);

interface UserConfigInputSource {
  readonly configYaml: string;
}

export const loadUserConfigInput = (source: UserConfigInputSource): unknown => {
  return parseUserConfigYaml(source.configYaml);
};

export const buildAppConfig = (config: UserConfig): AppConfig => {
  return {
    ...config,
    memberUserIds: config.members.map((member) => member.userId),
    memberDisplayNames: config.members.map((member) => member.displayName)
  };
};

const loadAppConfig = (): AppConfig => {
  try {
    const input = loadUserConfigInput({
      configYaml: env.SUMMIT_CONFIG_YAML
    });
    return buildAppConfig(parseUserConfigInput(input));
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      process.stderr.write(`Invalid user configuration:\n${formatConfigIssues(error)}\n`);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Invalid user configuration:\n${message}\n`);
    process.exit(1);
  }
};

export const appConfig = loadAppConfig();
