import { resolve } from "node:path";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";

export const performanceScenarios = ["normal", "unicode", "markdown", "parts", "overlap", "legacy", "soak", "mixed", "stream", "legacyqueue"] as const;
export type PerformanceScenario = typeof performanceScenarios[number];
interface PerformanceOptions {
  readonly image: string;
  readonly output: string;
  readonly repetitions: number;
  readonly rounds: number;
  readonly profile: boolean;
  readonly profileOnly: boolean;
  readonly databaseDiagnostics: boolean;
  readonly scenarios: readonly PerformanceScenario[];
}

const booleanFlags = new Set(["--profile", "--profile-only", "--database-diagnostics"]);
const valueFlags = new Set(["--output", "--scenario", "--repetitions", "--rounds"]);

/** Own token consumption and reject ambiguous flags before interpreting their values. */
const readPerformanceFlags = (flags: readonly string[]) => {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const name = flags[index];
    if (!name || seen.has(name)) { throw new CapacityError("setup_or_measurement", "arguments"); }
    seen.add(name);
    if (booleanFlags.has(name)) { continue; }
    if (!valueFlags.has(name)) { throw new CapacityError("setup_or_measurement", "arguments"); }
    const value = flags[++index];
    if (value === undefined || value.startsWith("--")) { throw new CapacityError("setup_or_measurement", "arguments"); }
    values.set(name, value);
  }
  return { values, seen };
};

const measurementCount = (value: string | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) { return fallback; }
  const count = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(count) || count > maximum) {
    throw new CapacityError("setup_or_measurement", "arguments");
  }
  return count;
};

const selectedScenarios = (value: string | undefined): readonly PerformanceScenario[] => {
  if (value === undefined || value === "all") { return performanceScenarios; }
  const scenario = performanceScenarios.find(candidate => candidate === value);
  if (scenario === undefined) { throw new CapacityError("setup_or_measurement", "arguments"); }
  return [scenario];
};

export const performanceOptions = (args: readonly string[]): PerformanceOptions => {
  const [image, ...flags] = args;
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) { throw new CapacityError("setup_or_measurement", "arguments"); }
  const { values, seen } = readPerformanceFlags(flags);
  const output = values.get("--output");
  const profile = seen.has("--profile");
  const profileOnly = seen.has("--profile-only");
  const databaseDiagnostics = seen.has("--database-diagnostics");
  if (!output || output.includes("\0") || (profile && profileOnly) || (profileOnly && seen.has("--repetitions"))
    || (databaseDiagnostics && (profile || profileOnly))) {
    throw new CapacityError("setup_or_measurement", "arguments");
  }
  return { image, output: resolve(output), repetitions: measurementCount(values.get("--repetitions"), 3, 10),
    rounds: measurementCount(values.get("--rounds"), 10, 50), scenarios: selectedScenarios(values.get("--scenario")),
    profile, profileOnly, databaseDiagnostics };
};

/** Nearest-rank percentiles retain actual observations; small tails remain
 * explicitly marked so a 20-observation p99 is not interpreted as a stable SLA. */
export const durationSummary = (values: readonly number[]) => {
  if (values.some(value => !Number.isFinite(value) || value < 0)) { throw new CapacityError("setup_or_measurement", "invalid_duration"); }
  if (values.length === 0) { return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null, smallTailSample: true }; }
  const sorted = [...values].sort((left, right) => left - right);
  const observedAtRank = (rank: number): number => {
    const value = sorted[rank - 1];
    if (value === undefined) { throw new CapacityError("setup_or_measurement", "invalid_duration"); }
    return value;
  };
  return { count: values.length, min: observedAtRank(1), max: observedAtRank(sorted.length),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: observedAtRank(Math.ceil(sorted.length * 0.5)), p95: observedAtRank(Math.ceil(sorted.length * 0.95)),
    p99: observedAtRank(Math.ceil(sorted.length * 0.99)), smallTailSample: values.length < 100 };
};
