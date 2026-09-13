import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import { describe, expect, it, vi } from "vitest";
import { fromDatabaseCall, fromDiscordCall } from "../../src/errors/effect.ts";
import { runEffect } from "../helpers/assertions.ts";

describe("typed foreign I/O effects", () => {
  it.each([
    { name: "database", wrap: fromDatabaseCall, code: "DATABASE" },
    { name: "Discord", wrap: fromDiscordCall, code: "DISCORD_API" }
  ])("defers $name I/O until execution and returns the actual value", async ({ wrap }) => {
    let value = "before execution";
    const call = vi.fn(async () => value);
    const operation = wrap(call, "Read failed.");
    expect(call).not.toHaveBeenCalled();
    value = "at execution";
    expect(await runEffect(operation)).toBe("at execution");
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([
    { wrap: fromDatabaseCall, code: "DATABASE", mode: "throw" },
    { wrap: fromDatabaseCall, code: "DATABASE", mode: "reject" },
    { wrap: fromDiscordCall, code: "DISCORD_API", mode: "throw" },
    { wrap: fromDiscordCall, code: "DISCORD_API", mode: "reject" }
  ])("classifies $code $mode in the typed error channel with its cause intact", async ({ wrap, code, mode }) => {
    const cause = new Error("foreign failure");
    const result = await runEffect(Effect.either(wrap(() => {
      if (mode === "throw") { throw cause; }
      return Promise.reject(cause);
    }, "Operation failed.")));
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) { throw new Error("Expected a typed I/O failure."); }
    expect(result.left.code).toBe(code);
    expect(result.left.cause).toBe(cause);
  });
});
