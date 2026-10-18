import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceReadiness } from "../../src/startup/maintenanceReadiness.ts";
import type { MaintenanceConnectionProof } from "../../src/startup/maintenanceConnectionProof.ts";
import { deferred } from "../helpers/deferred.ts";

const token = "operations-test-token-".repeat(3);
const fingerprint = { formatVersion: 1, targetFingerprint: "a".repeat(64), ledgerFingerprint: "b".repeat(64) } as const;
const expected = { service: "summit", mode: "frozen", contract: "summit-read-schema-v1", ready: true, database: fingerprint };

describe("frozen maintenance readiness", () => {
  let runtime: ReturnType<typeof createMaintenanceReadiness> | undefined;
  let release: (() => void) | undefined;
  const start = async (probe: () => Promise<MaintenanceConnectionProof> = async () => fingerprint): Promise<string> => {
    runtime = createMaintenanceReadiness(token, probe);
    await runtime.start("127.0.0.1", 0);
    const address = runtime.server.address();
    if (!address || typeof address === "string") { throw new Error("Expected loopback listener"); }
    return `http://127.0.0.1:${address.port}`;
  };
  const readiness = (origin: string, credential = token): Promise<Response> => fetch(`${origin}/internal/maintenance/readiness`, {
    headers: { authorization: `Bearer ${credential}` }
  });
  afterEach(async () => { runtime?.stop(); release?.(); await runtime?.drain(); release = undefined; });

  it("requires one operations credential and reports only fixed state and opaque identity", async () => {
    const probe = vi.fn(async () => fingerprint);
    const origin = await start(probe);
    const denied = await readiness(origin, "wrong");
    expect(denied.status).toBe(401); expect(await denied.json()).toStrictEqual({ error: "unauthorized" });
    const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${origin}/internal/maintenance/readiness`, {
        headers: ["Host", new URL(origin).host, "Authorization", `Bearer ${token}`, "Authorization", `Bearer ${token}`]
      }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      req.on("error", reject); req.end();
    });
    expect(duplicateStatus).toBe(401); expect(probe).not.toHaveBeenCalled();
    const response = await readiness(origin);
    expect(response.status).toBe(200); expect(await response.json()).toStrictEqual(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects every business route without invoking the database probe", async () => {
    const probe = vi.fn(async () => fingerprint); const origin = await start(probe);
    for (const [method, path] of [["POST", "/internal/discord-notifications"],
      ["PATCH", "/internal/discord-notifications/settings/ocr_completed"],
      ["POST", "/internal/discord-notifications/result:ocr_completed:test/retry"],
      ["GET", "/internal/discord-notifications/settings/analysis_completed"]] as const) {
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(503); expect(await response.json()).toStrictEqual({ error: "maintenance_frozen" });
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed on a database error and can recover without starting business work", async () => {
    let unavailable = true;
    const origin = await start(async () => { if (unavailable) { throw new Error("PRIVATE-DATABASE-DETAIL"); } return fingerprint; });
    const failed = await readiness(origin);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toStrictEqual({ service: "summit", mode: "frozen", contract: "summit-read-schema-v1", ready: false });
    unavailable = false;
    const recovered = await readiness(origin);
    expect(recovered.status).toBe(200); expect(await recovered.json()).toStrictEqual(expected);
  });

  it("bounds probes to one and drains the actual read before shutdown completes", async () => {
    const began = deferred<void>(); const gate = deferred<void>(); release = () => gate.resolve();
    const origin = await start(async () => { began.resolve(); await gate.promise; return fingerprint; });
    const pending = readiness(origin); await began.promise;
    const busy = await readiness(origin); expect(busy.status).toBe(503); await busy.arrayBuffer();
    runtime?.stop(); let drained = false;
    const draining = runtime?.drain().then(() => { drained = true; return undefined; });
    await setImmediate(); expect(drained).toBe(false);
    gate.resolve(); const response = await pending;
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ mode: "frozen", ready: false });
    await draining; expect(drained).toBe(true);
    expect(runtime?.server.listening).toBe(false);
  });

  it("closes a listen that finishes after stop and rejects a public bind", async () => {
    runtime = createMaintenanceReadiness(token, async () => fingerprint);
    await expect(runtime.start("0.0.0.0", 0)).rejects.toThrow("private or loopback");
    const starting = runtime.start("127.0.0.1", 0);
    runtime.stop(); await starting; await runtime.drain();
    expect(runtime.server.listening).toBe(false);
    await expect(runtime.start("127.0.0.1", 0)).rejects.toThrow("cannot be started again");
  });
});
