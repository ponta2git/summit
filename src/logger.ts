import pino from "pino";

export const logger = pino({
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
});
