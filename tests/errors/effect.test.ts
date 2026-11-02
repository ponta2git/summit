import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vitest";
import { fromDatabaseCall, fromDiscordCall } from "../../src/errors/effect.ts";
import { InvariantViolationError, NotificationAdmissionInvariantError, NotificationNotStartedError } from "../../src/errors/index.ts";
import { runPromiseBoundary } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";

describe("typed foreign I/O effects", () => {
  it("keeps the existing database classification for an unrelated application invariant", async () => {
    const cause = new InvariantViolationError("Existing application failure");
    const result = await runEffect(Effect.result(fromDatabaseCall(() => Promise.reject(cause), "Database failed")));
    if (!Result.isFailure(result)) { throw new Error("Expected a database failure"); }
    expect(result.failure.code).toBe("DATABASE"); expect(result.failure.cause).toBe(cause);
  });
  it.each([new NotificationAdmissionInvariantError("Producer bound exceeded"), new NotificationNotStartedError("stopped")])(
    "does not turn a local admission outcome into a retryable database failure", async failure => {
      const recovery = vi.fn(() => Effect.void);
      const operation = fromDatabaseCall(() => Promise.reject(failure), "Database failed").pipe(Effect.catch(recovery));
      await expect(runPromiseBoundary(operation)).rejects.toBe(failure);
      expect(recovery).not.toHaveBeenCalled();
    }
  );
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
    const result = await runEffect(Effect.result(wrap(() => {
      if (mode === "throw") { throw cause; }
      return Promise.reject(cause);
    }, "Operation failed.")));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) { throw new Error("Expected a typed I/O failure."); }
    expect(result.failure.code).toBe(code);
    expect(result.failure.cause).toBe(cause);
  });
});
