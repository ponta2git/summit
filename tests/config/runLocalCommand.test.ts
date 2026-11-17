import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalCommand } from "../../scripts/dev/runLocalCommand.ts";
import { serializeLogError } from "../../src/logger.error.ts";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

describe("local command cleanup ownership", () => {
  it("preserves both failure diagnostics after cleanup even when the first report fails", async () => {
    const operationError = Object.assign(new Error("operation"), { code: "ECONNREFUSED" });
    const cleanupError = Object.assign(new Error("cleanup"), { code: "ETIMEDOUT" });
    const events: string[] = [];
    const report = vi.fn<(error: unknown) => void>();
    report.mockImplementationOnce(() => { throw new Error("logger"); });
    await runLocalCommand(
      () => { events.push("operation"); throw operationError; },
      () => { events.push("cleanup"); return Promise.reject(cleanupError); },
      report
    );
    expect(events).toStrictEqual(["operation", "cleanup"]);
    expect(report.mock.calls).toStrictEqual([[operationError], [cleanupError]]);
    expect(report.mock.calls.map(([error]) => serializeLogError(error))).toStrictEqual([
      { type: "Error", code: "ECONNREFUSED" }, { type: "Error", code: "ETIMEDOUT" }
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("contains reporting failure after a successful operation and failed cleanup", async () => {
    const cleanupError = new Error("cleanup");
    const report = vi.fn<(error: unknown) => void>(() => { throw new Error("logger"); });
    await expect(runLocalCommand(
      () => Promise.resolve(),
      () => Promise.reject(cleanupError),
      report
    )).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(cleanupError);
    expect(process.exitCode).toBe(1);
  });

  it("leaves successful commands successful", async () => {
    process.exitCode = 0;
    const report = vi.fn<(error: unknown) => void>();
    await runLocalCommand(() => Promise.resolve(), () => Promise.resolve(), report);
    expect(report).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});
