import { describe, expect, it, vi } from "vitest";

import { runHealthcheckTickPing } from "../../src/scheduler/index.js";
import { logger } from "../../src/logger.js";

describe("runHealthcheckTickPing", () => {
  it("is a no-op when url is undefined — fetch is never called", async () => {
    const fetchFn = vi.fn();
    await runHealthcheckTickPing(undefined, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("logs event=healthcheck.tick_ping with ok=true on 200 and never logs the URL", async () => {
    const url = "https://hc-ping.example.com/fake-uuid-success";
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    try {
      await runHealthcheckTickPing(url, fetchFn);

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(infoSpy).toHaveBeenCalledOnce();
      const logFields = infoSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(logFields["event"]).toBe("healthcheck.tick_ping");
      expect(logFields["ok"]).toBe(true);
      expect(logFields["elapsedMs"]).toBeTypeOf("number");
      expect(logFields["status"]).toBe(200);
      // regression: URL must never appear in the logged fields
      expect(JSON.stringify(logFields)).not.toContain("hc-ping.example.com");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs event=healthcheck.tick_ping with ok=false on network error and never logs the URL", async () => {
    const url = "https://hc-ping.example.com/fake-uuid-fail";
    const fetchFn = vi.fn(async () => { throw new Error("Network error"); });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      await runHealthcheckTickPing(url, fetchFn);

      expect(warnSpy).toHaveBeenCalledOnce();
      const logFields = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(logFields["event"]).toBe("healthcheck.tick_ping");
      expect(logFields["ok"]).toBe(false);
      expect(logFields["elapsedMs"]).toBeTypeOf("number");
      expect(logFields["errorKind"]).toBe("network_error");
      // regression: URL must never appear in the logged fields
      expect(JSON.stringify(logFields)).not.toContain("hc-ping.example.com");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs errorKind=timeout on AbortError (signal timeout)", async () => {
    const url = "https://hc-ping.example.com/fake-uuid-timeout";
    const timeoutError = Object.assign(new Error("The operation was aborted."), { name: "TimeoutError" });
    const fetchFn = vi.fn(async () => { throw timeoutError; });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      await runHealthcheckTickPing(url, fetchFn);

      expect(warnSpy).toHaveBeenCalledOnce();
      const logFields = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(logFields["event"]).toBe("healthcheck.tick_ping");
      expect(logFields["ok"]).toBe(false);
      expect(logFields["errorKind"]).toBe("timeout");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs ok=false with status when server returns non-2xx", async () => {
    const url = "https://hc-ping.example.com/fake-uuid-5xx";
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      await runHealthcheckTickPing(url, fetchFn);

      expect(warnSpy).toHaveBeenCalledOnce();
      const logFields = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(logFields["event"]).toBe("healthcheck.tick_ping");
      expect(logFields["ok"]).toBe(false);
      expect(logFields["status"]).toBe(503);
      expect(logFields["errorKind"]).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
