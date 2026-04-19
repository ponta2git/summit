import pino from "pino";

export const loggerOptions = {
  level: "info",
  redact: {
    paths: [
      "token",
      "authorization",
      "Authorization",
      "headers.authorization",
      "headers.Authorization",
      "env.DISCORD_TOKEN",
      "env.DATABASE_URL",
      "env.DIRECT_URL",
      "env.HEALTHCHECK_PING_URL"
    ],
    remove: true
  }
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);
