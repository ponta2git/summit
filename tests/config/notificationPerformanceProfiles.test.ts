import { describe, expect, it } from "vitest";
import { summarizeCpuProfile, summarizeHeapProfile } from "../../scripts/perf/notificationPerformance.profileSummary.ts";

const frame = (functionName: string) => ({ functionName, scriptId: "1", url: "file:///app/dist/example.js", lineNumber: 2, columnNumber: 4 });

describe("notification performance profile summaries", () => {
  it("weights exclusive CPU samples by microseconds and separates idle time", () => {
    const summary = summarizeCpuProfile({ startTime: 0, endTime: 10_000,
      nodes: [{ id: 1, callFrame: frame("(idle)") }, { id: 2, callFrame: frame("render") }, { id: 3, callFrame: frame("render") }],
      samples: [1, 2, 3], timeDeltas: [7_000, 1_000, 2_000] });
    expect(summary).toMatchObject({ wallMs: 10, sampledMs: 10, idleMs: 7, samples: 3 });
    expect(summary.functions[1]).toMatchObject({ functionName: "render", url: "app/dist/example.js", lineNumber: 3,
      selfMs: 3, samples: 2, percentOfSamples: 30, percentOfNonIdleSamples: 100 });
    expect(summary.functions[0]?.percentOfNonIdleSamples).toBeNull();
  });

  it("rejects a CPU recording with a missing node or unmatched sample weights", () => {
    expect(() => summarizeCpuProfile({ startTime: 0, endTime: 10, nodes: [], samples: [3], timeDeltas: [10] })).toThrow("Missing CPU");
    expect(() => summarizeCpuProfile({ startTime: 0, endTime: 10, nodes: [], samples: [], timeDeltas: [10] })).toThrow("Invalid CPU");
  });

  it("keeps anonymous functions at different columns or evaluated scripts separate", () => {
    const summary = summarizeCpuProfile({ startTime: 0, endTime: 60,
      nodes: [{ id: 1, callFrame: frame("") }, { id: 2, callFrame: { ...frame(""), columnNumber: 40 } },
        { id: 3, callFrame: { ...frame(""), scriptId: "2" } }],
      samples: [1, 2, 3], timeDeltas: [10, 20, 30] });
    expect(summary.functions).toHaveLength(3);
    expect(summary.functions.map(value => value.selfMs)).toEqual([0.03, 0.02, 0.01]);
    expect(summary.functions[1]?.columnNumber).toBe(41);
  });

  it("sums heap self sizes across callers without double counting child allocations", () => {
    const summary = summarizeHeapProfile({ head: { id: 1, callFrame: frame("root"), selfSize: 10, children: [
      { id: 2, callFrame: frame("parse"), selfSize: 20, children: [
        { id: 3, callFrame: frame("parse"), selfSize: 30, children: [] }
      ] }
    ] }, samples: [{ size: 30, nodeId: 3, ordinal: 1 }] });
    expect(summary.estimatedAllocatedBytes).toBe(60);
    expect(summary.functions[0]).toMatchObject({ functionName: "parse", estimatedSelfBytes: 50 });
    expect(summary.functions[1]).toMatchObject({ functionName: "root", estimatedSelfBytes: 10 });
  });

  it("reports allocation samples absent from the exported tree without fabricating a frame", () => {
    const summary = summarizeHeapProfile({ head: { id: 1, callFrame: frame("root"), selfSize: 50, children: [] },
      samples: [{ size: 50, nodeId: 1, ordinal: 1 }, { size: 65_640, nodeId: 2, ordinal: 2 }] });
    expect(summary).toMatchObject({ estimatedAllocatedBytes: 50, samples: 2, sampleEstimatedBytes: 65_690,
      unattributedSamples: 1, unattributedSampleBytes: 65_640 });
    expect(summary.functions).toHaveLength(1);
    expect(summary.functions[0]?.percentOfAllocations).toBe(100);
  });
});
