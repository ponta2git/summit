import pino from "pino";

// redact: token / 接続文字列 / Authorization ヘッダをログに露出させない。
//   remove:true で path 自体を消すことで、JSON ログから完全に排除される。
// secret: env.DIRECT_URL / HEALTHCHECK_PING_URL の実値もここで防御。
// @see .github/instructions/secrets-review.instructions.md
export const loggerOptions = {
  level: "info",
  redact: {
    paths: [
      "DATABASE_URL",
      "DIRECT_URL",
      "HEALTHCHECK_PING_URL",
      "DISCORD_TOKEN",
      "token",
      "authorization",
      "Authorization",
      "headers.authorization",
      "headers.Authorization",
      "error.cause.headers.authorization",
      "error.cause.headers.Authorization",
      "request.headers.authorization",
      "request.headers.x-access-token",
      "request.headers.X-Access-Token",
      "response.headers.authorization",
      "env.DISCORD_TOKEN",
      "env.DATABASE_URL",
      "env.DIRECT_URL",
      "env.HEALTHCHECK_PING_URL"
    ],
    remove: true
  }
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);
