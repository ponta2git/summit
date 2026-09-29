import { readFile } from "node:fs/promises";
import { requireLocalTestUrl } from "../../tests/integration/databaseLifecycle.ts";
import { withCapacityContainer } from "../verify/notificationCapacity.container.ts";
import { seedLegacyCapacityNotification } from "../verify/notificationCapacity.fixtures.ts";
import { performanceOptions, performanceStage, type PerformanceScenario } from "./notificationPerformance.contract.ts";
import { notificationPerformanceProbe } from "./notificationPerformance.probe.ts";
import { runPerformanceScenario } from "./notificationPerformance.scenarios.ts";
import { createPerformanceOutput, performanceProvenance, performanceRoot,
  withPerformanceDatabase, writePerformanceArtifact } from "./notificationPerformance.storage.ts";
import { savePerformanceResult } from "./notificationPerformance.result.ts";
import { seedCapacityPartSources } from "./notificationPerformance.parts.ts";
import { performanceFailure } from "./notificationPerformance.diagnostics.ts";
import { withPerformanceCancellation } from "./notificationPerformance.cancellation.ts";

let output: string | undefined;
let currentRun: { scenario: PerformanceScenario; repetition: number; profiled: boolean } | undefined;
const verify = async (signal: AbortSignal): Promise<void> => {
  const options = performanceOptions(process.argv.slice(2));
  const adminUrl = await performanceStage("configuration", async () => requireLocalTestUrl(process.env["TEST_DATABASE_URL"]).href);
  await performanceStage("output_directory", () => createPerformanceOutput(options.output));
  output = options.output;
  const provenance = await performanceStage("provenance", () => performanceProvenance(options.image));
  signal.throwIfAborted();
  const configuration = await performanceStage("configuration", () => readFile(new URL("summit.config.example.yml", performanceRoot), "utf8"));
  await writePerformanceArtifact(output, "manifest.json", { schemaVersion: 1, startedAt: new Date().toISOString(),
    requested: { scenarios: options.scenarios, repetitions: options.profileOnly ? 0 : options.repetitions,
      rounds: options.rounds, profile: options.profile || options.profileOnly, profileOnly: options.profileOnly },
    resources: { memoryMiB: 256, swapMiB: 0, cpus: 1 }, provenance,
    methodology: { freshDatabasePerRun: true, freshContainerPerRun: true, fakeDiscordTransport: true,
      fixturesGeneratedOutsideContainer: true, forcedGcDuringWorkload: false, memorySamplingMilliseconds: 50,
      profileRunsSeparateFromBaseline: true, cpuQuotaIsNotAFlySharedCpuBenchmark: true } });
  const summaries: Awaited<ReturnType<typeof savePerformanceResult>>[] = [];
  const run = async (scenario: PerformanceScenario, repetition: number, profiled: boolean): Promise<void> => {
    signal.throwIfAborted();
    currentRun = { scenario, repetition, profiled };
    console.log(JSON.stringify({ event: "notification_performance.started", ...currentRun }));
    const summary = await performanceStage("database_setup", () => withPerformanceDatabase(adminUrl, async ({ url, client, version }) => {
      const legacyBytes = scenario === "legacy" ? await performanceStage("scenario_seed", () => seedLegacyCapacityNotification(client)) : undefined;
      if (scenario === "parts") { await performanceStage("scenario_seed", () => seedCapacityPartSources(client)); }
      const result = await performanceStage("container", () => withCapacityContainer({ image: provenance.image.id, memoryMiB: 256, databaseUrl: url, configuration,
        scenario: scenario === "legacy" ? "legacy" : "standard", cpus: 1, deadlineMs: 900_000, signal,
        probeScript: notificationPerformanceProbe, readyMarker: "PERFORMANCE_READY", env: { PERF_PROFILE: profiled ? "1" : "0" }
      }, session => performanceStage("workload", () => runPerformanceScenario(session, client, { scenario, rounds: options.rounds,
        ...(legacyBytes === undefined ? {} : { legacyBytes }) }))));
      return performanceStage("result", () => savePerformanceResult(output!, `${scenario}-${profiled ? "profile" : repetition.toString().padStart(2, "0")}`,
        { scenario, repetition, profiled, rounds: options.rounds, imageId: provenance.image.id, postgresVersion: version }, result));
    }, { signal }));
    summaries.push(summary);
  };
  if (!options.profileOnly) {
    for (const scenario of options.scenarios) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) { await run(scenario, repetition, false); }
    }
  }
  if (options.profile || options.profileOnly) { for (const scenario of options.scenarios) { await run(scenario, 1, true); } }
  await writePerformanceArtifact(output, "summary.json", { schemaVersion: 1, completedAt: new Date().toISOString(),
    percentileMethod: "nearest-rank", profileRunsExcludedFromBaseline: true, runs: summaries });
};

await withPerformanceCancellation(verify).catch(async (error: unknown) => {
  const { code, stage, diagnostic } = performanceFailure(error);
  process.exitCode = { setup_or_measurement: 1, receipt_rejected: 2, oom: 3, timeout: 4, memory_target: 5 }[code];
  if (output) {
    await writePerformanceArtifact(output, "failure.json", { schemaVersion: 1, code, stage, diagnostic, run: currentRun ?? null })
      .catch(() => { process.stderr.write("Performance failure artifact could not be written.\n"); });
  }
  // Never expose child stderr, SQL driver messages, URLs or input bodies.
  process.stderr.write(`Notification performance profiling failed: ${code} (${stage}).\n${JSON.stringify(diagnostic)}\n`);
});
