import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { loggerOptions } from "../../src/logger.js";
import { DatabaseError } from "../../src/errors/index.ts";

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
    expect(parsed).not.toHaveProperty("DISCORD_TOKEN");
    expect(parsed).not.toHaveProperty("env.DISCORD_TOKEN");
    expect(parsed).not.toHaveProperty("env.DATABASE_URL");
    expect(parsed).not.toHaveProperty("env.DIRECT_URL");
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

  it.each(["err", "error"])("limits %s and its causes to safe diagnostic fields", key => {
    const { logger, readLastLog } = createCapturedLogger();
    const driverError = Object.assign(new Error("connect postgres://user:private-canary@localhost/db"), {
      code: "23505", query: "select private-canary", parameters: ["private-canary"],
      detail: "Key (token)=(private-canary) already exists."
    });
    const discordError = Object.assign(new Error("private-canary in Discord response", { cause: driverError }), {
      name: "private-canary", status: 404, code: 10008,
      url: "https://discord.com/api/v10/webhooks/123456789012345678/private-canary",
      requestBody: { json: { content: "private-canary" } },
      rawError: { message: "private-canary" }, headers: { authorization: "Bearer private-canary" }
    });
    const error = new DatabaseError("private-canary in wrapper message", { cause: discordError });
    logger.error({ [key]: error, event: "operation.failed", sessionId: "s1" }, "Operation failed after persistence");
    const parsed = readLastLog();
    expect(parsed[key]).toStrictEqual({ type: "AppError", code: "DATABASE", cause: {
      type: "Error", status: 404, code: 10008, cause: { type: "Error", code: "23505" }
    } });
    expect(parsed).toMatchObject({ event: "operation.failed", sessionId: "s1", msg: "Operation failed after persistence" });
    expect(JSON.stringify(parsed)).not.toContain("private-canary");
  });

  it("prevents Pino from copying untrusted Error.message to the implicit log message", () => {
    const { logger, readLastLog } = createCapturedLogger();
    const error = new Error("postgres://user:private-canary@localhost/db");
    logger.error(error);
    expect(readLastLog()).toMatchObject({ err: { type: "Error" }, msg: "Operation failed" });
    expect(JSON.stringify(readLastLog())).not.toContain("private-canary");
    logger.error({ err: error, event: "scheduler.tick_failed" });
    expect(readLastLog()).toMatchObject({ err: { type: "Error" }, event: "scheduler.tick_failed", msg: "Operation failed" });
    expect(JSON.stringify(readLastLog())).not.toContain("private-canary");
  });

  it("bounds cause depth and cycles without reading arbitrary error accessors", () => {
    const { logger, readLastLog } = createCapturedLogger();
    const cycle = new Error("private-canary"); cycle.cause = cycle;
    logger.error({ error: cycle }, "Cycle");
    expect(readLastLog()["error"]).toStrictEqual({ type: "Error", cause: { type: "OmittedError", reason: "cycle" } });

    let error = new Error("private-canary");
    for (let depth = 0; depth < 20; depth += 1) { error = new Error("private-canary", { cause: error }); }
    logger.error({ error }, "Deep cause");
    expect(readLastLog()["error"]).toStrictEqual({ type: "Error", cause: { type: "Error", cause: {
      type: "Error", cause: { type: "Error", cause: { type: "OmittedError", reason: "depth_limit" } }
    } } });

    const accessors = Object.defineProperties(new Error("private-canary"), {
      cause: { get: () => { throw new Error("Accessor must not run"); } },
      code: { get: () => { throw new Error("Accessor must not run"); } }
    });
    expect(() => logger.error({ error: accessors }, "Accessor error")).not.toThrow();
    expect(readLastLog()["error"]).toStrictEqual({ type: "Error" });
    expect(JSON.stringify(readLastLog())).not.toContain("private-canary");
  });

  it("keeps known transport codes and suppresses arbitrary thrown strings and properties", () => {
    const { logger, readLastLog } = createCapturedLogger();
    logger.error({ error: { code: "ECONNRESET", status: 503, cause: "private-canary", message: "private-canary" } }, "Transport error");
    expect(readLastLog()["error"]).toStrictEqual({ type: "ThrownValue", code: "ECONNRESET", status: 503,
      cause: { type: "ThrownValue" } });
    expect(JSON.stringify(readLastLog())).not.toContain("private-canary");
    logger.error({ error: { code: "private-canary", status: "private-canary", token: "private-canary" } }, "Unknown error");
    expect(readLastLog()["error"]).toStrictEqual({ type: "ThrownValue" });
    logger.error({ error: "private-canary" }, "Thrown string");
    expect(readLastLog()["error"]).toStrictEqual({ type: "ThrownValue" });
  });
});
