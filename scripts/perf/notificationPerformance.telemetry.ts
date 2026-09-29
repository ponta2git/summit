// This source runs inside the measured production container, never on the host.
export const notificationPerformanceTelemetry = `
import { readFile } from 'node:fs/promises';
import { performance, PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';
import { Session } from 'node:inspector/promises';
import { setImmediate as immediate } from 'node:timers/promises';

const createPerformanceTelemetry = async () => {
  const limit = 100000;
  const profileEnabled = process.env.PERF_PROFILE === '1';
  const profileMode = { enabled: profileEnabled, cpuIntervalMicros: 1000,
    heapIntervalBytes: 65536, heapMode: 'allocations_including_collected_major_and_minor',
    window: {}, timestampMeaning: 'monotonic_time_immediately_before_inspector_command' };
  let profileSession;
  let profileStarted = false;
  let active = true;
  let timer;
  let sampling;
  let droppedSamples = 0;
  let sampleFailures = 0;
  let start = performance.now();
  let finishAt;
  let cpuBase = process.cpuUsage();
  let eluBase = performance.eventLoopUtilization();
  let cgroupBase;
  let samples = [];
  let durations = Object.create(null);
  let operationErrors = Object.create(null);
  let operationCounts = Object.create(null);
  let partOperations = { begin: [], complete: [] };
  let pauses = [];
  let byKind = Object.create(null);
  let gcCount = 0, gcTotal = 0, gcMax = 0;
  let gcRanges = [];
  let diagnostics = [];
  let diagnosticCpu = { user: 0, system: 0 };
  let diagnosticWallMs = 0;
  let peak = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0, cgroupCurrent: 0 };
  const checkpoints = {};
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const append = (array, value) => { if (array.length < limit) array.push(value); else droppedSamples++; };
  const retainedObservationCounts = () => ({
    operationDurations: Object.values(durations).reduce((sum, values) => sum + values.length, 0),
    partOperations: partOperations.begin.length + partOperations.complete.length,
    memorySamples: samples.length, gcPauses: pauses.length, diagnosticCheckpoints: diagnostics.length
  });
  const readCgroup = async () => {
    const [current, peakText, cpuText] = await Promise.all([
      readFile('/sys/fs/cgroup/memory.current', 'utf8'), readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
      readFile('/sys/fs/cgroup/cpu.stat', 'utf8')
    ]);
    const cpuStat = Object.fromEntries(cpuText.trim().split('\\n').map(line => {
      const [key, value] = line.trim().split(/\\s+/); return [key, Number(value)];
    }));
    return { cgroupCurrent: Number(current), cgroupPeak: Number(peakText), cpuStat };
  };
  const memory = async () => ({ atMonotonicMs: performance.now(), ...process.memoryUsage(), ...await readCgroup() });
  const checkpoint = async name => {
    const result = { ...await memory(), heapSpaceStats: getHeapSpaceStatistics(), heapStatistics: getHeapStatistics(),
      retainedObservationCounts: retainedObservationCounts() };
    if (name) checkpoints[name] = result;
    return result;
  };
  const sample = () => {
    if (sampling) return sampling;
    sampling = (async () => {
      const result = await memory();
      if (active) {
        for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], result[key]);
        append(samples, { ...result, elapsedMs: result.atMonotonicMs - start });
      }
      return result;
    })().finally(() => { sampling = undefined; });
    return sampling;
  };
  const consumeGc = entries => {
    for (const entry of entries) {
      if (!active || entry.startTime < start || (finishAt !== undefined && entry.startTime > finishAt)) continue;
      if (gcRanges.some(range => entry.startTime >= range.start && entry.startTime <= range.end)) continue;
      const kind = entry.detail?.kind ?? 0;
      const value = { startMs: entry.startTime - start, durationMs: entry.duration, kind, flags: entry.detail?.flags ?? 0 };
      const group = byKind[kind] ??= { count: 0, totalMs: 0, maxMs: 0 };
      group.count++; group.totalMs += entry.duration; group.maxMs = Math.max(group.maxMs, entry.duration);
      gcCount++; gcTotal += entry.duration; gcMax = Math.max(gcMax, entry.duration); append(pauses, value);
    }
  };
  const observer = new PerformanceObserver(list => consumeGc(list.getEntries()));
  const beginObservation = () => {
    observer.observe({ entryTypes: ['gc'] }); delay.reset(); delay.enable();
    timer = setInterval(() => { void sample().catch(() => { sampleFailures++; }); }, 50);
  };
  const diagnosticGc = async (name = 'postGc') => {
    delay.disable();
    const before = performance.now(); const cpu = process.cpuUsage();
    const range = { start: before, end: Infinity }; append(gcRanges, range);
    globalThis.gc();
    range.end = performance.now();
    const used = process.cpuUsage(cpu);
    diagnosticCpu.user += used.user; diagnosticCpu.system += used.system; diagnosticWallMs += range.end - before;
    await immediate(); consumeGc(observer.takeRecords());
    const result = { ...await checkpoint(name), gcWallMs: range.end - before, cpuUserMicros: used.user, cpuSystemMicros: used.system };
    append(diagnostics, result);
    if (active) delay.enable();
    return result;
  };
  globalThis.gc();
  await immediate();
  checkpoints.baseline = await checkpoint();
  cgroupBase = checkpoints.baseline.cpuStat;
  start = performance.now(); cpuBase = process.cpuUsage(); eluBase = performance.eventLoopUtilization();
  beginObservation();

  const reset = async () => {
    if (profileStarted) throw new Error('Profile window is already active');
    clearInterval(timer); await sampling;
    active = false; observer.disconnect(); delay.disable();
    if (profileEnabled) {
      profileSession = new Session(); profileSession.connect();
      await profileSession.post('Profiler.enable');
      await profileSession.post('Profiler.setSamplingInterval', { interval: profileMode.cpuIntervalMicros });
      await profileSession.post('HeapProfiler.enable');
      profileMode.window.heapStartMonotonicMs = performance.now();
      await profileSession.post('HeapProfiler.startSampling', { samplingInterval: profileMode.heapIntervalBytes,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      profileMode.window.cpuStartMonotonicMs = performance.now();
      await profileSession.post('Profiler.start'); profileStarted = true;
    }
    samples = []; durations = Object.create(null); operationErrors = Object.create(null); operationCounts = Object.create(null);
    partOperations = { begin: [], complete: [] }; pauses = []; byKind = Object.create(null);
    gcCount = 0; gcTotal = 0; gcMax = 0; gcRanges = []; diagnostics = [];
    diagnosticCpu = { user: 0, system: 0 }; diagnosticWallMs = 0;
    droppedSamples = 0; sampleFailures = 0;
    peak = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0, cgroupCurrent: 0 };
    delete checkpoints.end; delete checkpoints.postGc;
    checkpoints.warm = await checkpoint(); cgroupBase = checkpoints.warm.cpuStat;
    start = performance.now(); finishAt = undefined; cpuBase = process.cpuUsage(); eluBase = performance.eventLoopUtilization();
    active = true; beginObservation(); await sample();
  };
  const record = (operation, milliseconds, failed, part) => {
    if (!active) return;
    operationCounts[operation] = (operationCounts[operation] ?? 0) + 1;
    append(durations[operation] ??= [], milliseconds);
    if (failed) operationErrors[operation] = (operationErrors[operation] ?? 0) + 1;
    if (part && partOperations[operation]) append(partOperations[operation], { ...part, durationMs: milliseconds, failed });
  };
  const histogram = () => {
    const ms = value => Number.isFinite(value) ? value / 1e6 : null;
    return { resolutionMs: 10, count: Number(delay.count), min: delay.count ? ms(delay.min) : null,
      max: delay.count ? ms(delay.max) : null, mean: ms(delay.mean), stddev: ms(delay.stddev),
      p50: delay.count ? ms(delay.percentile(50)) : null, p95: delay.count ? ms(delay.percentile(95)) : null,
      p99: delay.count ? ms(delay.percentile(99)) : null };
  };
  const metrics = async (details = false) => {
    const current = await sample(); consumeGc(observer.takeRecords());
    const cpu = process.cpuUsage(cpuBase); const end = finishAt ?? performance.now();
    const cgroupDelta = Object.fromEntries(Object.entries(current.cpuStat).map(([key, value]) => [key, value - (cgroupBase[key] ?? 0)]));
    return { runtime: { versions: process.versions, platform: process.platform, arch: process.arch }, profileMode,
      window: { startMonotonicMs: start, endMonotonicMs: end, elapsedMs: end - start },
      cpu: { userMicros: cpu.user, systemMicros: cpu.system,
        excludingDiagnosticGc: { userMicros: Math.max(0, cpu.user - diagnosticCpu.user), systemMicros: Math.max(0, cpu.system - diagnosticCpu.system) },
        cgroupDelta },
      eventLoop: { utilization: performance.eventLoopUtilization(eluBase), delayMs: histogram(),
        utilizationIncludesDiagnosticGc: true, delayExcludesDiagnosticGc: true },
      gc: { count: gcCount, totalMs: gcTotal, maxMs: gcMax, byKind, ...(details ? { pauses } : {}) },
      diagnosticGc: { count: diagnostics.length, totalWallMs: diagnosticWallMs,
        cpuUserMicros: diagnosticCpu.user, cpuSystemMicros: diagnosticCpu.system, ...(details ? { checkpoints: diagnostics } : {}) },
      baselineRss: (checkpoints.warm ?? checkpoints.baseline).rss, peakRss: peak.rss,
      maxRss: process.resourceUsage().maxRSS * 1024, cgroupPeak: current.cgroupPeak,
      memory: { current, peak, sampleIntervalMs: 50, cgroupPeakScope: 'container_lifetime' }, checkpoints,
      operationCounts, operationErrors, droppedSamples, sampleFailures,
      retainedObservationCounts: retainedObservationCounts(),
      ...(details ? { operationDurationsMs: durations, partOperations, memorySamples: samples } : {}) };
  };
  const finish = async () => {
    clearInterval(timer); await sampling; await immediate();
    checkpoints.end = await checkpoint();
    const result = await metrics(true); finishAt = result.window.endMonotonicMs;
    active = false; delay.disable(); consumeGc(observer.takeRecords()); observer.disconnect();
    // Workload metrics freeze before diagnostic GC, profiler stop, or serialization.
    let cpuProfile, heapProfile;
    if (profileSession) {
      // Stop allocation sampling before exporting CPU nodes/samples into JS.
      profileMode.window.heapStopMonotonicMs = performance.now();
      heapProfile = (await profileSession.post('HeapProfiler.stopSampling')).profile;
      profileMode.window.cpuStopMonotonicMs = performance.now();
      cpuProfile = (await profileSession.post('Profiler.stop')).profile;
      profileSession.disconnect(); profileSession = undefined;
    }
    const beforeGcCpu = process.cpuUsage(); const beforeGcTime = performance.now();
    globalThis.gc();
    const gcFinishedAt = performance.now();
    const gcCpu = process.cpuUsage(beforeGcCpu);
    await immediate();
    const postGc = await checkpoint('postGc');
    const finalization = { postGc, gcWallMs: gcFinishedAt - beforeGcTime,
      gcCpuUserMicros: gcCpu.user, gcCpuSystemMicros: gcCpu.system, postGcIncludesProfileObjects: profileEnabled };
    return { metrics: result, finalization, cpuProfile, heapProfile };
  };
  return { reset, record, metrics, finish, diagnosticGc, checkpoint, append };
};
`;
