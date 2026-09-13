import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "../../src/errors/index.ts";
import { runSchedulerBatchResult, type SchedulerResult } from "../../src/scheduler/scheduler.types.ts";

describe("scheduler batch failure isolation", () => {
  it.each(["throw", "reject", "result"])("preserves AppError identity and continues after an item %s", async mode => {
    const failure = new DatabaseError("item unavailable"); const onFailure = vi.fn();
    const visited: string[] = [];
    const result = await runSchedulerBatchResult("recovery", ["failed", "next"], id => {
      visited.push(id);
      if (id === "next") { return okAsync(1); }
      if (mode === "throw") { throw failure; }
      if (mode === "reject") { return okAsync(0).map(() => { throw failure; }); }
      return errAsync(failure);
    }, sessionId => ({ sessionId }), onFailure);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) { throw result.error; }
    expect(result.value).toStrictEqual({ processed: 2, succeeded: 1,
      failures: [{ phase: "recovery", sessionId: "failed", error: failure }] });
    expect(result.value.failures[0]?.error).toBe(failure);
    expect(visited).toStrictEqual(["failed", "next"]);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"])("reports an item defect as invariant failure on %s and continues", async mode => {
    const defect = new TypeError("broken adapter");
    const visited: string[] = [];
    const result = await runSchedulerBatchResult("recovery", ["failed", "next"], id => {
      visited.push(id);
      if (id === "next") { return okAsync(1); }
      if (mode === "throw") { throw defect; }
      return okAsync(0).map(() => { throw defect; });
    }, sessionId => ({ sessionId }), () => undefined);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) { throw result.error; }
    expect(result.value.processed).toBe(2);
    expect(result.value.succeeded).toBe(1);
    expect(result.value.failures).toHaveLength(1);
    expect(result.value.failures[0]).toMatchObject({ phase: "recovery", sessionId: "failed",
      error: { code: "INVARIANT_VIOLATION", cause: defect } });
    expect(visited).toStrictEqual(["failed", "next"]);
  });

  it.each(["identify", "successCount", "onFailure"])("fails the phase if %s bookkeeping is defective", async stage => {
    const defect = new TypeError("invalid report");
    const fail = (): never => { throw defect; };
    const run = vi.fn((): SchedulerResult<number> => stage === "onFailure"
      ? errAsync(new DatabaseError("item unavailable")) : okAsync(1));
    const result = await runSchedulerBatchResult("recovery", ["first", "next"], run,
      stage === "identify" ? fail : sessionId => ({ sessionId }),
      stage === "onFailure" ? fail : () => undefined,
      stage === "successCount" ? fail : value => value);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) { throw new Error("Expected an invalid batch report to fail."); }
    expect(result.error.code).toBe("INVARIANT_VIOLATION");
    expect(result.error.cause).toBe(defect);
    expect(run).toHaveBeenCalledTimes(stage === "identify" ? 0 : 1);
  });
});
