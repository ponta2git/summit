import * as Either from "effect/Either";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { runEffect } from "../helpers/assertions.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "../../src/errors/index.ts";
import { runSchedulerBatchEffect, type SchedulerEffect } from "../../src/scheduler/scheduler.types.ts";

describe("scheduler batch failure isolation", () => {
  it.each(["throw", "reject", "typed failure"])("preserves AppError identity and continues after an item %s", async mode => {
    const failure = new DatabaseError("item unavailable"); const onFailure = vi.fn();
    const visited: string[] = [];
    const result = await runEffect(Effect.either(runSchedulerBatchEffect("recovery", ["failed", "next"], id => {
      visited.push(id);
      if (id === "next") { return Effect.succeed(1); }
      if (mode === "throw") { throw failure; }
      if (mode === "reject") { return Effect.promise(() => Promise.reject(failure)); }
      return Effect.fail(failure);
    }, sessionId => ({ sessionId }), onFailure)));
    expect(Either.isRight(result)).toBe(true);
    if (!Either.isRight(result)) { throw result.left; }
    expect(result.right).toStrictEqual({ processed: 2, succeeded: 1,
      failures: [{ phase: "recovery", sessionId: "failed", error: failure }] });
    expect(result.right.failures[0]?.error).toBe(failure);
    expect(visited).toStrictEqual(["failed", "next"]);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"])("reports an item defect as invariant failure on %s and continues", async mode => {
    const defect = new TypeError("broken adapter");
    const visited: string[] = [];
    const result = await runEffect(Effect.either(runSchedulerBatchEffect("recovery", ["failed", "next"], id => {
      visited.push(id);
      if (id === "next") { return Effect.succeed(1); }
      if (mode === "throw") { throw defect; }
      return Effect.promise(() => Promise.reject(defect));
    }, sessionId => ({ sessionId }), () => undefined)));
    expect(Either.isRight(result)).toBe(true);
    if (!Either.isRight(result)) { throw result.left; }
    expect(result.right.processed).toBe(2);
    expect(result.right.succeeded).toBe(1);
    expect(result.right.failures).toHaveLength(1);
    expect(result.right.failures[0]).toMatchObject({ phase: "recovery", sessionId: "failed",
      error: { code: "INVARIANT_VIOLATION", cause: defect } });
    expect(visited).toStrictEqual(["failed", "next"]);
  });

  it.each(["identify", "successCount", "onFailure"])("fails the phase if %s bookkeeping is defective", async stage => {
    const defect = new TypeError("invalid report");
    const fail = (): never => { throw defect; };
    const run = vi.fn((): SchedulerEffect<number> => stage === "onFailure"
      ? Effect.fail(new DatabaseError("item unavailable")) : Effect.succeed(1));
    const result = await runEffect(Effect.either(runSchedulerBatchEffect("recovery", ["first", "next"], run,
      stage === "identify" ? fail : sessionId => ({ sessionId }),
      stage === "onFailure" ? fail : () => undefined,
      stage === "successCount" ? fail : value => value)));
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) { throw new Error("Expected an invalid batch report to fail."); }
    expect(result.left.code).toBe("INVARIANT_VIOLATION");
    expect(result.left.cause).toBe(defect);
    expect(run).toHaveBeenCalledTimes(stage === "identify" ? 0 : 1);
  });

  it("defers work and allocates a fresh report for every execution", async () => {
    const run = vi.fn(() => Effect.succeed(2));
    const identify = vi.fn((sessionId: string) => ({ sessionId }));
    const batch = runSchedulerBatchEffect("recovery", ["session"], run, identify, () => undefined, value => value);
    expect(run).not.toHaveBeenCalled(); expect(identify).not.toHaveBeenCalled();
    expect(await runEffect(batch)).toStrictEqual({ processed: 1, succeeded: 2, failures: [] });
    expect(await runEffect(batch)).toStrictEqual({ processed: 1, succeeded: 2, failures: [] });
    expect(run).toHaveBeenCalledTimes(2); expect(identify).toHaveBeenCalledTimes(2);
  });

  it("propagates interruption without reporting an item failure or starting another item", async () => {
    const visited: string[] = []; const onFailure = vi.fn();
    const batch = runSchedulerBatchEffect("recovery", ["interrupted", "next"], id => {
      visited.push(id);
      return id === "interrupted" ? Effect.interrupt : Effect.succeed(1);
    }, sessionId => ({ sessionId }), onFailure);
    const exit = await runEffect(Effect.exit(batch));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected interruption to propagate."); }
    expect(Cause.isInterrupted(exit.cause)).toBe(true);
    expect(visited).toStrictEqual(["interrupted"]); expect(onFailure).not.toHaveBeenCalled();
  });
});
