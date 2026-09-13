import { EventEmitter } from "node:events";
import { RESTEvents, type RateLimitData } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { attachRateLimitLogging } from "../../src/startup/rateLimitLogging.ts";
import { logger } from "../../src/logger.ts";
import { asDiscordClient } from "../helpers/discord.ts";

describe("Discord rate limit diagnostics", () => {
  it("logs timing and route templates without webhook token-bearing parameters", () => {
    const rest = new EventEmitter();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    attachRateLimitLogging(asDiscordClient({ rest }));
    rest.emit(RESTEvents.RateLimited, {
      global: false, hash: "bucket", limit: 1, majorParameter: "123456789012345678/dummy-webhook-token",
      method: "POST", retryAfter: 100, route: "/webhooks/:id/:token", scope: "shared",
      sublimitTimeout: 0, timeToReset: 100, url: "https://discord.com/api/webhooks/123456789012345678/dummy-webhook-token"
    } satisfies RateLimitData);
    expect(warn).toHaveBeenCalledWith({
      event: "discord.rate_limited", route: "/webhooks/:id/:token", method: "POST",
      retryAfter: 100, limit: 1, timeToReset: 100, globalLimit: false
    }, "Discord REST rate limit hit");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("dummy-webhook-token");
  });
});
