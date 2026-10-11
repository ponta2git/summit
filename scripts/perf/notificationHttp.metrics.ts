import { z } from "zod";

const milliseconds = z.number().finite().nonnegative();
const durations = z.array(milliseconds);
const summary = z.object({ count: z.number().int().positive(), p50: milliseconds, p95: milliseconds, max: milliseconds });

export const notificationHttpMeasurements = z.object({
  schemaVersion: z.literal(1),
  runtime: z.object({ node: z.string(), platform: z.string(), arch: z.string() }),
  methodology: z.object({ loopback: z.literal(true), fakeDatabase: z.literal(true), tls: z.literal(false),
    concurrentRequests: z.literal(1), repetitions: z.literal(5), requestsPerRun: z.literal(500),
    maxRequestsPerSocket: z.number().int().positive(), percentileMethod: z.literal("nearest-rank") }),
  runs: z.array(z.object({ repetition: z.number().int().min(1).max(5), mode: z.enum(["cold", "reused"]),
    connections: z.number().int().positive(), elapsedMs: milliseconds,
    requestMs: durations.length(500), connectMs: durations, coldRequestMs: durations, reusedRequestMs: durations
  }).refine(run => run.connections === run.connectMs.length && run.connections === run.coldRequestMs.length
    && run.coldRequestMs.length + run.reusedRequestMs.length === run.requestMs.length
    && (run.mode !== "cold" || run.reusedRequestMs.length === 0), "Inconsistent HTTP observations")).length(10),
  summary: z.object({ coldRequestMs: summary, reusedRequestMs: summary, connectMs: summary })
});

export const summarizeHttpDurations = (samples: readonly number[]): z.infer<typeof summary> => {
  if (samples.length === 0) { throw new Error("No HTTP observations"); }
  const sorted = [...samples].sort((a, b) => a - b);
  return summary.parse({ count: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) });
};
