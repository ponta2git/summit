import { resolve } from "node:path";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";
export { performanceStage } from "./notificationPerformance.diagnostics.ts";

export const performanceScenarios = ["normal", "unicode", "markdown", "parts", "overlap", "legacy", "soak"] as const;
export type PerformanceScenario = typeof performanceScenarios[number];
export interface PerformanceOptions {
  readonly image: string;
  readonly output: string;
  readonly repetitions: number;
  readonly rounds: number;
  readonly profile: boolean;
  readonly profileOnly: boolean;
  readonly scenarios: readonly PerformanceScenario[];
}

export const performanceOptions = (args: readonly string[]): PerformanceOptions => {
  const [image, ...flags] = args;
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) { throw new CapacityError("setup_or_measurement", "arguments"); }
  let output: string | undefined;
  let repetitions = 3;
  let rounds = 10;
  let profile = false;
  let profileOnly = false;
  let scenarios: readonly PerformanceScenario[] = performanceScenarios;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const name = flags[index];
    if (!name || seen.has(name)) { throw new CapacityError("setup_or_measurement", "arguments"); }
    seen.add(name);
    if (name === "--profile") { profile = true; continue; }
    if (name === "--profile-only") { profileOnly = true; continue; }
    const value = flags[++index];
    if (value === undefined || value.startsWith("--")) { throw new CapacityError("setup_or_measurement", "arguments"); }
    if (name === "--output" && value.length > 0 && !value.includes("\0")) { output = resolve(value); }
    else if (name === "--scenario" && value === "all") { scenarios = performanceScenarios; }
    else if (name === "--scenario" && performanceScenarios.some(scenario => scenario === value)) { scenarios = [value as PerformanceScenario]; }
    else if ((name === "--repetitions" || name === "--rounds") && /^[1-9][0-9]*$/.test(value)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number > (name === "--repetitions" ? 10 : 50)) { throw new CapacityError("setup_or_measurement", "arguments"); }
      if (name === "--repetitions") { repetitions = number; } else { rounds = number; }
    } else { throw new CapacityError("setup_or_measurement", "arguments"); }
  }
  if (!output || (profile && profileOnly) || (profileOnly && seen.has("--repetitions"))) {
    throw new CapacityError("setup_or_measurement", "arguments");
  }
  return { image, output, repetitions, rounds, profile, profileOnly, scenarios };
};

/** Nearest-rank percentiles retain actual observations; small tails remain
 * explicitly marked so a 20-observation p99 is not interpreted as a stable SLA. */
export const durationSummary = (values: readonly number[]) => {
  if (values.some(value => !Number.isFinite(value) || value < 0)) { throw new CapacityError("setup_or_measurement", "invalid_duration"); }
  if (values.length === 0) { return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null, smallTailSample: true }; }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { count: values.length, min: sorted[0]!, max: sorted.at(-1)!,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), smallTailSample: values.length < 100 };
};
