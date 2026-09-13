import pino from "pino";
import { serializeLogError } from "./logger.error.ts";

// redact: token / 接続文字列 / Authorization ヘッダをログに露出させない。
//   remove:true で path 自体を消すことで、JSON ログから完全に排除される。
// secret: env.DIRECT_URL の実値もここで防御。
// @see docs/architecture.md
export const loggerOptions = {
  level: "info",
  serializers: { err: serializeLogError, error: serializeLogError },
  hooks: {
    logMethod(args, method) {
      const first: unknown = args[0];
      // secret: Pinoはserializerより先にError.messageを補うため、暗黙のmsgも固定する。
      if (args[1] === undefined && (first instanceof Error
        || (typeof first === "object" && first !== null && Object.hasOwn(first, "err")))) {
        args[1] = "Operation failed";
      }
      method.apply(this, args);
    }
  },
  redact: {
    paths: [
      "DATABASE_URL",
      "DIRECT_URL",
      "DISCORD_TOKEN",
      "RESULT_NOTIFICATION_TOKEN",
      "RESULT_NOTIFICATION_OPERATIONS_TOKEN",
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
      "env.RESULT_NOTIFICATION_TOKEN",
      "env.RESULT_NOTIFICATION_OPERATIONS_TOKEN",
      "env.DATABASE_URL",
      "env.DIRECT_URL"
    ],
    remove: true
  }
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);
