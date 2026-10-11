import { readFile } from "node:fs/promises";
import { Agent, request } from "node:http";
import { notificationHttpMeasurements, summarizeHttpDurations } from "./notificationHttp.metrics.ts";

const run = async (): Promise<void> => {
  if (process.argv.length !== 2) { throw new Error("No arguments are supported"); }
  // invariant: loopbackとfake DBだけを使い、local設定・secretを読み込まない。
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RESULT_NOTIFICATION_") || key === "FLY_IMAGE_REF" || key === "GIT_SHA") { delete process.env[key]; }
  }
  Object.assign(process.env, { NODE_ENV: "test", DISCORD_TOKEN: "dummy-token",
    DATABASE_URL: "postgres://summit:summit@localhost:5433/summit",
    SUMMIT_CONFIG_YAML: await readFile(new URL("../../summit.config.example.yml", import.meta.url), "utf8") });
  const [{ createNotificationReceiver }, { createFakeResultNotificationsPort }, { ocrNotification }, config] = await Promise.all([
    import("../../src/notifications/http.ts"), import("../../tests/testing/ports.resultNotifications.ts"),
    import("../../tests/features/result-notifications/fixtures.ts"), import("../../src/notifications/config.ts")
  ]);
  const now = new Date("2026-10-12T00:00:00.000Z");
  const token = "fixture-receiver-token-000000000000000000";
  const body = JSON.stringify({ ...ocrNotification(), settingsGeneration: "0" });
  const measure = async (mode: "cold" | "reused", count: number) => {
    const port = createFakeResultNotificationsPort({ now: () => now }); port.setTargetAvailable("match_draft", "draft-1", true);
    const receiver = createNotificationReceiver({ port, clock: { now: () => now }, token,
      operationsToken: "fixture-operations-token-0000000000000000", canAccept: () => true, wake: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    let connections = 0; receiver.server.on("connection", () => { connections += 1; });
    const requestMs: number[] = [], connectMs: number[] = [], coldRequestMs: number[] = [], reusedRequestMs: number[] = [];
    try {
      await receiver.start("127.0.0.1", 0);
      const address = receiver.server.address();
      if (!address || typeof address === "string") { throw new Error("No loopback listener"); }
      const started = performance.now();
      for (let index = 0; index < count; index += 1) {
        await new Promise<void>((resolve, reject) => {
          const start = performance.now();
          const req = request({ hostname: "127.0.0.1", port: address.port, path: "/internal/discord-notifications", method: "POST", agent,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body),
              connection: mode === "cold" ? "close" : "keep-alive" }
          }, res => {
            res.resume(); res.once("error", reject);
            res.once("end", () => {
              if (res.statusCode !== (index === 0 ? 202 : 200)) { reject(new Error("Unexpected receipt status")); return; }
              const elapsed = performance.now() - start; requestMs.push(elapsed);
              (req.reusedSocket ? reusedRequestMs : coldRequestMs).push(elapsed); resolve();
            });
          });
          req.once("socket", socket => {
            if (socket.connecting) {
              const connectStarted = performance.now(); socket.once("connect", () => connectMs.push(performance.now() - connectStarted));
            }
          });
          req.once("error", reject); req.setTimeout(5_000, () => req.destroy(new Error("Request deadline"))); req.end(body);
        });
      }
      return { mode, connections, elapsedMs: performance.now() - started, requestMs, connectMs, coldRequestMs, reusedRequestMs };
    } finally { agent.destroy(); receiver.stop(); await receiver.drain(); }
  };
  await measure("cold", 20); await measure("reused", 20);
  const runs = [];
  for (let repetition = 1; repetition <= 5; repetition += 1) {
    const order = repetition % 2 === 1 ? ["cold", "reused"] as const : ["reused", "cold"] as const;
    for (const mode of order) { runs.push({ repetition, ...await measure(mode, 500) }); }
  }
  console.log(JSON.stringify(notificationHttpMeasurements.parse({ schemaVersion: 1,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    methodology: { loopback: true, fakeDatabase: true, tls: false, concurrentRequests: 1, repetitions: 5, requestsPerRun: 500,
      maxRequestsPerSocket: config.RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET, percentileMethod: "nearest-rank" }, runs,
    summary: { coldRequestMs: summarizeHttpDurations(runs.filter(value => value.mode === "cold").flatMap(value => value.requestMs)),
      reusedRequestMs: summarizeHttpDurations(runs.filter(value => value.mode === "reused").flatMap(value => value.reusedRequestMs)),
      connectMs: summarizeHttpDurations(runs.flatMap(value => value.connectMs)) }
  })));
};

await run().catch(() => { process.stderr.write("Notification loopback HTTP measurement failed.\n"); process.exitCode = 1; });
