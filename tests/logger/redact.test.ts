import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { loggerOptions } from "../../src/logger.js";

const createCapturedLogger = (): {
  logger: pino.Logger;
  readLastLog: () => Record<string, unknown>;
} => {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const logger = pino(loggerOptions, destination);

  return {
    logger,
    readLastLog: () => {
      const lines = output.trim().split("\n");
      const lastLine = lines.at(-1);
      if (!lastLine) {
        return {};
      }
      return JSON.parse(lastLine) as Record<string, unknown>;
    }
  };
};

describe("logger redaction", () => {
  it("removes configured secret fields", () => {
    const { logger, readLastLog } = createCapturedLogger();

    logger.info(
      {
        DATABASE_URL: "postgres://db-user:db-pass@localhost:5433/summit",
        DIRECT_URL: "postgres://direct-user:direct-pass@localhost:5433/summit",
        HEALTHCHECK_PING_URL: "https://hc-ping.com/secret",
        DISCORD_TOKEN: "discord-token",
        token: "top-secret-token",
        authorization: "Bearer secret",
        Authorization: "Bearer secret",
        headers: {
          authorization: "Bearer nested-secret",
          Authorization: "Bearer nested-secret"
        },
        env: {
          DISCORD_TOKEN: "discord-token",
          DATABASE_URL: "postgres://db-user:db-pass@localhost:5433/summit",
          DIRECT_URL: "postgres://direct-user:direct-pass@localhost:5433/summit",
          HEALTHCHECK_PING_URL: "https://hc-ping.com/secret"
        }
      },
      "msg"
    );

    const parsed = readLastLog();

    expect(parsed).not.toHaveProperty("token");
    expect(parsed).not.toHaveProperty("authorization");
    expect(parsed).not.toHaveProperty("Authorization");
    expect(parsed).not.toHaveProperty("headers.authorization");
    expect(parsed).not.toHaveProperty("headers.Authorization");
    expect(parsed).not.toHaveProperty("DATABASE_URL");
    expect(parsed).not.toHaveProperty("DIRECT_URL");
    expect(parsed).not.toHaveProperty("HEALTHCHECK_PING_URL");
    expect(parsed).not.toHaveProperty("DISCORD_TOKEN");
    expect(parsed).not.toHaveProperty("env.DISCORD_TOKEN");
    expect(parsed).not.toHaveProperty("env.DATABASE_URL");
    expect(parsed).not.toHaveProperty("env.DIRECT_URL");
    expect(parsed).not.toHaveProperty("env.HEALTHCHECK_PING_URL");
    expect(JSON.stringify(parsed)).not.toContain("postgres://db-user:db-pass@localhost:5433/summit");
  });

  it("keeps structured context fields that are not redacted", () => {
    const { logger, readLastLog } = createCapturedLogger();

    logger.info(
      {
        sessionId: "s1",
        weekKey: "2026-W16",
        userId: "u1"
      },
      "ctx"
    );

    const parsed = readLastLog();

    expect(parsed).toHaveProperty("sessionId", "s1");
    expect(parsed).toHaveProperty("weekKey", "2026-W16");
    expect(parsed).toHaveProperty("userId", "u1");
  });
});
