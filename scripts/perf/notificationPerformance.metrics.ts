import { z } from "zod";

const number = z.number();
const count = z.number().int().nonnegative();
const numbers = z.record(z.string(), number);
const durations = z.array(z.number().nonnegative());
const observations = z.object({ operationDurations: count, partOperations: count, memorySamples: count,
  gcPauses: count, diagnosticCheckpoints: count });
const memory = z.object({ atMonotonicMs: number, rss: count, heapTotal: count, heapUsed: count, external: count,
  arrayBuffers: count, cgroupCurrent: count, cgroupPeak: count, cpuStat: numbers });
const checkpoint = memory.extend({ heapSpaceStats: z.array(z.object({ space_name: z.string(), space_size: count,
  space_used_size: count, space_available_size: count, physical_space_size: count })), heapStatistics: numbers,
  retainedObservationCounts: observations });
const latency = z.object({ receiptToFirstSend: durations, receiptToComplete: durations,
  claimToFirstSend: durations, claimToComplete: durations, firstSendToComplete: durations });
const partOperation = z.object({ notificationOrdinal: count, partNo: count, durationMs: number, failed: z.boolean() });

/** Whitelist measurement fields. Configuration, request/response bodies and
 * authentication data cannot enter report JSON through an accidental spread. */
export const performanceMetrics = z.object({
  runtime: z.object({ versions: z.record(z.string(), z.string()), platform: z.string(), arch: z.string() }),
  profileMode: z.object({ enabled: z.boolean(), cpuIntervalMicros: count, heapIntervalBytes: count,
    heapMode: z.literal("allocations_including_collected_major_and_minor"), window: numbers,
    timestampMeaning: z.literal("monotonic_time_immediately_before_inspector_command") }),
  window: z.object({ startMonotonicMs: number, endMonotonicMs: number, elapsedMs: number }),
  cpu: z.object({ userMicros: number, systemMicros: number,
    excludingDiagnosticGc: z.object({ userMicros: number, systemMicros: number }), cgroupDelta: numbers }),
  eventLoop: z.object({ utilization: z.object({ idle: number, active: number, utilization: number }),
    delayMs: z.object({ resolutionMs: count, count, min: number.nullable(), max: number.nullable(),
      mean: number.nullable(), stddev: number.nullable(), p50: number.nullable(), p95: number.nullable(), p99: number.nullable() }),
    utilizationIncludesDiagnosticGc: z.boolean(), delayExcludesDiagnosticGc: z.boolean() }),
  gc: z.object({ count, totalMs: number, maxMs: number,
    byKind: z.record(z.string(), z.object({ count, totalMs: number, maxMs: number })),
    pauses: z.array(z.object({ startMs: number, durationMs: number, kind: count, flags: count })) }),
  diagnosticGc: z.object({ count, totalWallMs: number, cpuUserMicros: number, cpuSystemMicros: number,
    checkpoints: z.array(checkpoint.extend({ gcWallMs: number, cpuUserMicros: number, cpuSystemMicros: number })) }),
  baselineRss: count, peakRss: count, maxRss: count, cgroupPeak: count,
  memory: z.object({ current: memory, peak: z.object({ rss: count, heapTotal: count, heapUsed: count, external: count,
    arrayBuffers: count, cgroupCurrent: count }), sampleIntervalMs: count, cgroupPeakScope: z.literal("container_lifetime") }),
  checkpoints: z.record(z.string(), checkpoint), operationCounts: numbers, operationErrors: numbers,
  retainedObservationCounts: observations,
  droppedSamples: z.literal(0), sampleFailures: z.literal(0), operationDurationsMs: z.record(z.string(), durations),
  partOperations: z.object({ begin: z.array(partOperation), complete: z.array(partOperation) }),
  memorySamples: z.array(memory.extend({ elapsedMs: number })), notificationLatencyMs: latency,
  completedNotifications: z.array(z.object({ notificationOrdinal: count, parts: count, payloadBytes: count,
    origin: z.enum(["seeded_claim", "receipt"]), receiptToFirstSendMs: number.nullable(), receiptToCompleteMs: number.nullable(),
    claimToFirstSendMs: number.nullable(), claimToCompleteMs: number.nullable(), firstSendToCompleteMs: number.nullable() })),
  finalization: z.object({ postGc: checkpoint, gcWallMs: number, gcCpuUserMicros: number, gcCpuSystemMicros: number,
    postGcIncludesProfileObjects: z.boolean(), postSerialization: checkpoint }),
  received: count, sentParts: count, sendCount: count, sendAttempts: count, deliveredNotifications: count,
  pendingSends: z.literal(0), pendingReceipts: z.literal(0), inflightOperations: z.literal(0), activeNotifications: z.literal(0),
  maxPendingSends: count, maxPendingReceipts: count, maxInflightOperations: count,
  maxClaimBatchBytes: count, maxClaimBatchCount: count, maxActivePayloadBytes: count,
  protocolFailures: z.literal(0), applicationWarnings: count, applicationErrors: z.literal(0), receiptDispositions: numbers
});
const callFrame = z.object({ functionName: z.string(), scriptId: z.string(), url: z.string(), lineNumber: number, columnNumber: number });
export const cpuProfileSchema = z.object({ startTime: number, endTime: number, nodes: z.array(z.object({
  id: number, callFrame, hitCount: number.optional(), children: z.array(number).optional(), deoptReason: z.string().optional(),
  positionTicks: z.array(z.object({ line: number, ticks: number })).optional()
})), samples: z.array(number).optional(), timeDeltas: z.array(number).optional() });
interface HeapNode { readonly id: number; readonly selfSize: number; readonly callFrame: z.infer<typeof callFrame>; readonly children: readonly HeapNode[]; }
const heapNode: z.ZodType<HeapNode> = z.lazy(() => z.object({ id: number, selfSize: number, callFrame, children: z.array(heapNode) }));
export const heapProfileSchema = z.object({ head: heapNode, samples: z.array(z.object({ size: number, nodeId: number, ordinal: number })) });
