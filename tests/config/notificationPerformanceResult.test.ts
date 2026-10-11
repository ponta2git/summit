import { describe, expect, it } from "vitest";
import { assertPerformanceOperationErrors } from "../../scripts/perf/notificationPerformance.result.ts";

describe("notification performance expected failure contract", () => {
  const conflicts = { receive: 4, receiveTotal: 4 };
  const diagnostics = { ...conflicts, "database.transactionWall.receive": 4, "database.gateHold.receive": 4 };

  it("accepts only expected receipt conflicts and their acquired-gate transaction rollback observations", () => {
    expect(() => assertPerformanceOperationErrors(conflicts, 4, false)).not.toThrow();
    expect(() => assertPerformanceOperationErrors(diagnostics, 4, true)).not.toThrow();
    expect(() => assertPerformanceOperationErrors({}, 0, true)).not.toThrow();
  });

  it.each([
    { ...diagnostics, "database.gateCall.receive": 1 },
    { ...diagnostics, "database.transactionWall.claim": 1 },
    { ...diagnostics, "database.gateHold.receive": 5 },
    { ...diagnostics, "database.transactionWall.receive": 3 },
    { ...diagnostics, complete: 1 },
    conflicts
  ])("rejects missing, extra or mismatched diagnostic failures", actual => {
    expect(() => assertPerformanceOperationErrors(actual, 4, true)).toThrow("Expected values to be strictly deep-equal");
  });

  it("does not allow diagnostic failures in a timing baseline or a run without expected conflicts", () => {
    expect(() => assertPerformanceOperationErrors(diagnostics, 4, false)).toThrow("Expected values to be strictly deep-equal");
    expect(() => assertPerformanceOperationErrors(diagnostics, 0, true)).toThrow("Expected values to be strictly deep-equal");
  });
});
