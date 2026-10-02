import { z } from "zod";

export const capacityMetrics = z.object({
  baselineRss: z.number().positive(), peakRss: z.number().positive(), maxRss: z.number().positive(),
  cgroupPeak: z.number().positive(), received: z.number().int().nonnegative(),
  sentParts: z.number().int().nonnegative(), deliveredNotifications: z.number().int().nonnegative(),
  pendingSends: z.number().int().nonnegative(), pendingReceipts: z.number().int().nonnegative(),
  maxPendingSends: z.number().int().nonnegative(), maxPendingReceipts: z.number().int().nonnegative(),
  maxClaimBatchBytes: z.number().int().nonnegative(), maxClaimBatchCount: z.number().int().nonnegative(),
  protocolFailures: z.literal(0)
});
export type CapacityMetrics = z.infer<typeof capacityMetrics>;
export type CapacityScenario = "standard" | "legacy";
export type CapacityFailure = "oom" | "timeout" | "receipt_rejected" | "memory_target" | "setup_or_measurement";
export class CapacityError extends Error {
  readonly code: CapacityFailure;
  readonly detail: string | undefined;
  constructor(code: CapacityFailure, detail?: string) { super(code); this.code = code; this.detail = detail; }
}

export const capacityOptions = (args: readonly string[]) => {
  const [image, ...flags] = args;
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) || flags.length % 2 !== 0) {
    throw new CapacityError("setup_or_measurement");
  }
  let memoryMiB = 256;
  let targetMiB = 192;
  let scenario: CapacityScenario | "all" = "all";
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (!name || seen.has(name)) { throw new CapacityError("setup_or_measurement"); }
    seen.add(name);
    if (name === "--scenario" && (value === "standard" || value === "legacy" || value === "all")) { scenario = value; }
    else if ((name === "--memory-mib" || name === "--target-mib") && value && /^[1-9][0-9]*$/.test(value)) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 8_192) { throw new CapacityError("setup_or_measurement"); }
      if (name === "--memory-mib") { memoryMiB = parsed; } else { targetMiB = parsed; }
    } else { throw new CapacityError("setup_or_measurement"); }
  }
  if (targetMiB >= memoryMiB) { throw new CapacityError("setup_or_measurement"); }
  return { image, memoryMiB, targetMiB, scenario };
};

export const capacityTargetMet = (metrics: CapacityMetrics, targetMiB: number): boolean =>
  metrics.cgroupPeak <= targetMiB * 1024 * 1024;
