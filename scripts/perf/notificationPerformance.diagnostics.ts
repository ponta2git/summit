import { AssertionError } from "node:assert";
import { ZodError } from "zod";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";

// Path segments are schema vocabulary, never arbitrary record keys or values.
const pathWords = new Set(("runtime versions platform arch profileMode enabled cpuIntervalMicros heapIntervalBytes heapMode window "
  + "timestampMeaning startMonotonicMs endMonotonicMs elapsedMs cpu userMicros systemMicros excludingDiagnosticGc cgroupDelta "
  + "eventLoop utilization idle active delayMs resolutionMs count min max mean stddev p50 p95 p99 utilizationIncludesDiagnosticGc "
  + "delayExcludesDiagnosticGc gc totalMs maxMs byKind pauses startMs durationMs kind flags diagnosticGc totalWallMs "
  + "cpuUserMicros cpuSystemMicros checkpoints baseline warm end postGc baselineRss peakRss maxRss cgroupPeak memory current "
  + "peak sampleIntervalMs cgroupPeakScope operationCounts operationErrors retainedObservationCounts operationDurations "
  + "partOperations memorySamples gcPauses diagnosticCheckpoints droppedSamples sampleFailures operationDurationsMs begin "
  + "complete notificationOrdinal partNo failed atMonotonicMs rss heapTotal heapUsed external arrayBuffers cgroupCurrent "
  + "cpuStat heapSpaceStats space_name space_size space_used_size space_available_size physical_space_size heapStatistics "
  + "notificationLatencyMs receiptToFirstSend receiptToComplete claimToFirstSend claimToComplete firstSendToComplete "
  + "completedNotifications parts payloadBytes origin receiptToFirstSendMs receiptToCompleteMs claimToFirstSendMs "
  + "claimToCompleteMs firstSendToCompleteMs finalization gcWallMs gcCpuUserMicros gcCpuSystemMicros postGcIncludesProfileObjects "
  + "postSerialization received sentParts sendCount sendAttempts deliveredNotifications pendingSends pendingReceipts "
  + "inflightOperations activeNotifications maxPendingSends maxPendingReceipts maxInflightOperations maxClaimBatchBytes "
  + "maxClaimBatchCount maxActivePayloadBytes protocolFailures applicationWarnings applicationErrors receiptDispositions "
  + "cpuProfile heapProfile startTime endTime nodes id callFrame functionName scriptId url lineNumber columnNumber hitCount "
  + "children deoptReason positionTicks line ticks samples timeDeltas head selfSize size nodeId ordinal receive receiveTotal "
  + "claim plan renew fail getNextDispatchAt inspect retry prune getSetting setSetting accepted duplicate cancelled "
  + "usage_usec user_usec system_usec nr_periods nr_throttled throttled_usec total_heap_size total_heap_size_executable "
  + "total_physical_size total_available_size used_heap_size heap_size_limit malloced_memory peak_malloced_memory "
  + "does_zap_garbage number_of_native_contexts number_of_detached_contexts total_global_handles_size used_global_handles_size external_memory").split(/\s+/));
const issueCodes = new Set(["invalid_type", "invalid_value", "too_big", "too_small", "invalid_format", "not_multiple_of",
  "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "custom"]);
const operators = new Set(["==", "!=", "===", "!==", "strictEqual", "notStrictEqual", "deepEqual", "notDeepEqual",
  "deepStrictEqual", "notDeepStrictEqual", "match", "doesNotMatch", "ok", "fail"]);
const systemCodes = new Set(["EEXIST", "ENOENT", "EACCES", "EPERM", "ENOSPC", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ABORT_ERR",
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const valueType = (value: unknown): string => value === null ? "null" : typeof value;

const safeDiagnostic = (error: unknown) => {
  if (error instanceof AssertionError) {
    return { kind: "assertion", operator: operators.has(error.operator) ? error.operator : "other",
      actualType: valueType(error.actual), expectedType: valueType(error.expected),
      ...(typeof error.actual === "number" && Number.isFinite(error.actual) ? { actual: error.actual } : {}),
      ...(typeof error.expected === "number" && Number.isFinite(error.expected) ? { expected: error.expected } : {}) };
  }
  if (error instanceof ZodError) {
    return { kind: "schema", issues: error.issues.slice(0, 12).map(issue => ({
      path: issue.path.slice(0, 16).map(segment => typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0
        ? segment : typeof segment === "string" && pathWords.has(segment) ? segment : "[key]"),
      code: issueCodes.has(issue.code) ? issue.code : "unknown"
    })), omittedIssues: Math.max(0, error.issues.length - 12) };
  }
  let code: string | undefined;
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if ("code" in current && typeof current.code === "string" && systemCodes.has(current.code)) { code = current.code; break; }
    current = current.cause;
  }
  return { kind: "exception", name: error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : "Error",
    ...(code === undefined ? {} : { systemCode: code }) };
};

class PerformanceDiagnosticError extends CapacityError {
  readonly diagnostic: ReturnType<typeof safeDiagnostic>;
  constructor(stage: string, error: unknown) {
    super(error instanceof CapacityError ? error.code : "setup_or_measurement", stage);
    this.diagnostic = safeDiagnostic(error);
  }
}

export const performanceStage = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
  try { return await action(); }
  catch (error) {
    // Inner fixed diagnostics have more evidence than their outer orchestration.
    if (error instanceof CapacityError && error.detail !== undefined) { throw error; }
    throw new PerformanceDiagnosticError(stage, error);
  }
};

export const performanceFailure = (error: unknown) => ({
  code: error instanceof CapacityError ? error.code : "setup_or_measurement" as const,
  stage: error instanceof CapacityError ? error.detail ?? "configuration_or_setup" : "configuration_or_setup",
  diagnostic: error instanceof PerformanceDiagnosticError ? error.diagnostic : safeDiagnostic(error)
});
