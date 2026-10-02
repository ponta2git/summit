import { z } from "zod";

const frame = z.object({ functionName: z.string(), scriptId: z.string(), url: z.string(),
  lineNumber: z.number().int(), columnNumber: z.number().int() });
type Frame = z.infer<typeof frame>;
interface CpuProfileSummary {
  readonly wallMs: number; readonly samples: number; readonly sampledMs: number; readonly idleMs: number;
  readonly functions: readonly (Frame & { readonly selfMs: number; readonly samples: number;
    readonly percentOfSamples: number; readonly percentOfNonIdleSamples: number | null })[];
}
interface HeapProfileSummary {
  readonly estimatedAllocatedBytes: number; readonly samples: number;
  readonly sampleEstimatedBytes: number; readonly unattributedSamples: number; readonly unattributedSampleBytes: number;
  readonly functions: readonly (Frame & { readonly estimatedSelfBytes: number; readonly percentOfAllocations: number })[];
}
const cpuSchema = z.object({
  startTime: z.number(), endTime: z.number(),
  nodes: z.array(z.object({ id: z.number().int(), callFrame: frame })),
  samples: z.array(z.number().int()), timeDeltas: z.array(z.number().nonnegative())
});
interface HeapNode { id: number; callFrame: Frame; selfSize: number; children: HeapNode[] }
const heapNode: z.ZodType<HeapNode> = z.lazy(() => z.object({
  id: z.number().int(), callFrame: frame, selfSize: z.number().nonnegative(), children: z.array(heapNode)
}));
const heapSchema = z.object({ head: heapNode, samples: z.array(z.object({
  size: z.number().nonnegative(), nodeId: z.number().int(), ordinal: z.number().int()
})) });

const location = (value: Frame): Frame => ({ ...value,
  url: value.url.replace(/^file:\/\/\/app\//, "app/"), lineNumber: value.lineNumber + 1, columnNumber: value.columnNumber + 1 });
const keyOf = (value: Frame): string => JSON.stringify([value.scriptId, value.functionName, value.url, value.lineNumber, value.columnNumber]);

/** Exclusive sampled time avoids counting the same interval at each caller.
 * Delta weights are microseconds; idle and GC remain explicit rows. */
export const summarizeCpuProfile = (input: unknown): CpuProfileSummary => {
  const profile = cpuSchema.parse(input);
  if (profile.samples.length !== profile.timeDeltas.length || profile.endTime < profile.startTime) {
    throw new Error("Invalid CPU profile interval");
  }
  const nodes = new Map(profile.nodes.map(node => [node.id, location(node.callFrame)]));
  if (nodes.size !== profile.nodes.length) { throw new Error("Duplicate CPU profile node"); }
  const functions = new Map<string, { frame: Frame; microseconds: number; samples: number }>();
  for (let index = 0; index < profile.samples.length; index++) {
    const callFrame = nodes.get(profile.samples[index]!);
    if (!callFrame) { throw new Error("Missing CPU profile node"); }
    const key = keyOf(callFrame);
    const aggregate = functions.get(key) ?? { frame: callFrame, microseconds: 0, samples: 0 };
    aggregate.microseconds += profile.timeDeltas[index]!;
    aggregate.samples++;
    functions.set(key, aggregate);
  }
  const rows = [...functions.values()].sort((left, right) => right.microseconds - left.microseconds);
  const sampledMicros = rows.reduce((sum, row) => sum + row.microseconds, 0);
  const idleMicros = rows.filter(row => row.frame.functionName === "(idle)").reduce((sum, row) => sum + row.microseconds, 0);
  return { wallMs: (profile.endTime - profile.startTime) / 1000, samples: profile.samples.length,
    sampledMs: sampledMicros / 1000, idleMs: idleMicros / 1000,
    functions: rows.map(row => ({ ...row.frame, selfMs: row.microseconds / 1000, samples: row.samples,
      percentOfSamples: sampledMicros ? row.microseconds / sampledMicros * 100 : 0,
      percentOfNonIdleSamples: row.frame.functionName === "(idle)" || sampledMicros === idleMicros ? null
        : row.microseconds / (sampledMicros - idleMicros) * 100 })) };
};

/** Sampling selfSize estimates allocated bytes, including collected objects
 * when the recording enabled both includeObjectsCollected flags. It is not RSS
 * or retained/live heap. Aggregate frames across distinct calling contexts. */
export const summarizeHeapProfile = (input: unknown): HeapProfileSummary => {
  const profile = heapSchema.parse(input);
  const functions = new Map<string, { frame: Frame; bytes: number }>();
  const ids = new Set<number>();
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop()!;
    if (ids.has(node.id)) { throw new Error("Duplicate heap profile node"); }
    ids.add(node.id);
    const callFrame = location(node.callFrame);
    const key = keyOf(callFrame);
    const aggregate = functions.get(key) ?? { frame: callFrame, bytes: 0 };
    aggregate.bytes += node.selfSize;
    functions.set(key, aggregate);
    pending.push(...node.children);
  }
  // V8 builds the tree before the samples list; export-time allocations can
  // reference a node absent from the earlier tree. Keep this discrepancy visible
  // instead of silently dropping it or inventing an attribution.
  const unattributed = profile.samples.filter(sample => !ids.has(sample.nodeId));
  const rows = [...functions.values()].filter(row => row.bytes > 0).sort((left, right) => right.bytes - left.bytes);
  const allocatedBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  return { estimatedAllocatedBytes: allocatedBytes, samples: profile.samples.length,
    sampleEstimatedBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    unattributedSamples: unattributed.length,
    unattributedSampleBytes: unattributed.reduce((sum, sample) => sum + sample.size, 0),
    functions: rows.map(row => ({ ...row.frame, estimatedSelfBytes: row.bytes,
      percentOfAllocations: allocatedBytes ? row.bytes / allocatedBytes * 100 : 0 })) };
};
