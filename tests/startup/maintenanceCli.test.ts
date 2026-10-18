import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runMaintenanceCli } from "../../src/startup/maintenanceCli.run.ts";
import { createMaintenanceReadiness } from "../../src/startup/maintenanceReadiness.ts";

const token = "operations-test-token-".repeat(3);
const database = { formatVersion: 1, targetFingerprint: "a".repeat(64), ledgerFingerprint: "b".repeat(64) } as const;
const writers = ["startup", "discord_interactions", "reconnect_recovery", "scheduler", "ask_sends", "notification_operations", "result_notifications"]
  .map(name => ({ name, stage: name === "result_notifications" ? "all" : "admission", status: "drained" }));
const drained = { consumer: "summit", scope: "process", cutoverId: "fixture", stopEpoch: 3, stage: "all", phase: "drained", writers };
const environment = (port: number): Record<string, string> => ({ RESULT_NOTIFICATION_BIND_HOST: "127.0.0.1",
  RESULT_NOTIFICATION_PORT: String(port), RESULT_NOTIFICATION_OPERATIONS_TOKEN: token });

describe("machine-local maintenance CLI", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); } });

  it("reads the live frozen listener and retains only the common database proof", async () => {
    const server = createMaintenanceReadiness(token, async () => database);
    await server.start("127.0.0.1", 0);
    cleanups.push(async () => { server.stop(); await server.drain(); });
    const address = server.server.address();
    if (!address || typeof address === "string") { throw new Error("Expected loopback listener"); }
    const output: string[] = [];
    await runMaintenanceCli(["readiness"], environment(address.port), text => output.push(text));
    expect(output.map(text => JSON.parse(text) as unknown)).toStrictEqual([
      { service: "summit", mode: "frozen", ready: true, contract: "summit-read-schema-v1", database }
    ]);
  });

  it("sends the exact cutover request and rejects mismatched, partial, redirected or unbounded replies without disclosure", async () => {
    let reply: unknown = drained;
    let status = 202;
    const requests: { method: string | undefined; authorization: string | undefined; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
      requests.push({ method: request.method, authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
      response.writeHead(status, { "content-type": "application/json", location: "http://127.0.0.1:1/private-fixture" });
      response.end(JSON.stringify(reply));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    if (!address || typeof address === "string") { throw new Error("Expected loopback listener"); }
    const output: string[] = [];
    const run = (): Promise<void> => runMaintenanceCli(["drain", "fixture", "3", "all"], environment(address.port), text => output.push(text));
    await run();
    expect(requests[0]).toStrictEqual({ method: "POST", authorization: `Bearer ${token}`,
      body: { cutoverId: "fixture", stopEpoch: 3, stage: "all" } });
    expect(JSON.parse(output[0] ?? "null")).toStrictEqual(drained);
    output.length = 0;
    for (const invalid of [{ ...drained, stopEpoch: 4 }, { ...drained, writers: writers.slice(1) },
      { ...drained, privateValue: token }, "private-fixture-".repeat(1024)]) {
      reply = invalid;
      await expect(run()).rejects.toThrow("Maintenance command failed; inspect process state before retrying");
      expect(output).toStrictEqual([]);
    }
    status = 302; reply = drained;
    await expect(run()).rejects.toThrow("Maintenance command failed");
    expect(output).toStrictEqual([]);
  });

  it("rejects invalid or public target settings and malformed operation identities before network access", async () => {
    const output: string[] = [];
    for (const changed of [{ RESULT_NOTIFICATION_BIND_HOST: "example.com" }, { RESULT_NOTIFICATION_PORT: "65536" },
      { RESULT_NOTIFICATION_OPERATIONS_TOKEN: "invalid" }]) {
      await expect(runMaintenanceCli(["status"], { ...environment(1), ...changed }, text => output.push(text))).rejects.toThrow("Maintenance command failed");
    }
    for (const args of [["drain", "fixture", "1e2", "all"], ["drain", "fixture", "9007199254740992", "all"],
      ["drain", "private/value", "3", "all"], ["readiness", "extra"]]) {
      await expect(runMaintenanceCli(args, environment(1), text => output.push(text))).rejects.toThrow("Maintenance command failed");
    }
    expect(output).toStrictEqual([]);
  });
});
