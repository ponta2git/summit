import { RESTEvents, type Client } from "discord.js";

import { logger } from "../logger.ts";

export const attachRateLimitLogging = (client: Client): void => {
  // why: 429 の route と retryAfter を構造化ログで観測するため購読する。
  client.rest.on(RESTEvents.RateLimited, (info) => {
    try {
      logger.warn(
        {
          event: "discord.rate_limited",
          route: info.route,
          method: info.method,
          // secret: webhookのmajorParameterはID/tokenを含むため、route templateだけ記録する。
          retryAfter: info.retryAfter,
          limit: info.limit,
          timeToReset: info.timeToReset,
          globalLimit: info.global
        },
        "Discord REST rate limit hit"
      );
    } catch {
      // why: listener 内の例外を上位へ伝播させない（EventEmitter uncaught 回避）。
    }
  });
};
