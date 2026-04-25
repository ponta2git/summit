import { RESTEvents, type Client } from "discord.js";

import { logger } from "../logger.js";

export const attachRateLimitLogging = (client: Client): void => {
  // why: 429 の route/retryAfter を観測するため購読 → ADR-0019 (M11)
  client.rest.on(RESTEvents.RateLimited, (info) => {
    try {
      logger.warn(
        {
          event: "discord.rate_limited",
          route: info.route,
          method: info.method,
          majorParameter: info.majorParameter,
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
