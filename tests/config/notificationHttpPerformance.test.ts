import { describe, expect, it } from "vitest";
import { notificationHttpMeasurements, summarizeHttpDurations } from "../../scripts/perf/notificationHttp.metrics.ts";

const fixture = () => ({ schemaVersion: 1, runtime: { node: "v24", platform: "darwin", arch: "arm64" },
  methodology: { loopback: true, fakeDatabase: true, tls: false, concurrentRequests: 1, repetitions: 5, requestsPerRun: 500,
    maxRequestsPerSocket: 100, percentileMethod: "nearest-rank" },
  runs: Array.from({ length: 10 }, (_, index) => ({ repetition: Math.floor(index / 2) + 1,
    mode: index % 2 === 0 ? "cold" : "reused", connections: index % 2 === 0 ? 500 : 5, elapsedMs: 100,
    requestMs: Array<number>(500).fill(1), connectMs: Array<number>(index % 2 === 0 ? 500 : 5).fill(0.1),
    coldRequestMs: Array<number>(index % 2 === 0 ? 500 : 5).fill(1), reusedRequestMs: Array<number>(index % 2 === 0 ? 0 : 495).fill(1) })),
  summary: { coldRequestMs: summarizeHttpDurations([1]), reusedRequestMs: summarizeHttpDurations([1]), connectMs: summarizeHttpDurations([0.1]) }
});

describe("loopback HTTP performance report", () => {
  it("uses nearest-rank percentiles and rejects missing or invalid duration observations", () => {
    expect(summarizeHttpDurations([4, 1, 3, 2])).toEqual({ count: 4, p50: 2, p95: 4, max: 4 });
    expect(() => summarizeHttpDurations([])).toThrow("No HTTP observations");
    expect(() => summarizeHttpDurations([Infinity])).toThrow(/Invalid/);
  });

  it("rejects mismatched socket counts or incomplete measurement runs", () => {
    expect(notificationHttpMeasurements.safeParse(fixture()).success).toBe(true);
    const mismatch = fixture(); mismatch.runs[0]!.connections -= 1;
    expect(notificationHttpMeasurements.safeParse(mismatch).success).toBe(false);
    const incomplete = fixture(); incomplete.runs.pop();
    expect(notificationHttpMeasurements.safeParse(incomplete).success).toBe(false);
  });

  it("whitelists measurements without echoing request headers or configuration", () => {
    const report = notificationHttpMeasurements.parse({ ...fixture(), token: "private-fixture",
      runtime: { ...fixture().runtime, databaseUrl: "private-fixture" },
      runs: fixture().runs.map(run => ({ ...run, headers: { authorization: "private-fixture" } })) });
    expect(JSON.stringify(report)).not.toContain("private-fixture");
  });
});
