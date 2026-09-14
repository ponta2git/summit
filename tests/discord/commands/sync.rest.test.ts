import { type RESTOptions } from "@discordjs/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandRest, runCommandSync } from "../../../src/commands/sync.run.ts";
import { slashCommands } from "../../../src/commands/definitions.ts";
import { SYNC_REQUEST_TIMEOUT_MS } from "../../../src/commands/sync.protocol.ts";
import { deferred } from "../../helpers/deferred.ts";

const settings = { production: true, check: false, token: "controlled-dummy-token", applicationId: "100000000000000001", guildId: "100000000000000002" };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
afterEach(() => vi.useRealTimers());

describe("real Discord REST adapter with an offline HTTP boundary", () => {
  it("uses guild-only GET/PUT/GET, the shared payload and the supplied abort signal", async () => {
    const request = vi.fn<RESTOptions["makeRequest"]>().mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(slashCommands)).mockResolvedValueOnce(response(slashCommands));
    const report = await runCommandSync(settings, new AbortController().signal, input => createCommandRest(input, { makeRequest: request }));
    expect(report).toStrictEqual({ status: "synced" });
    expect(request.mock.calls.map(([url, init]) => ({ path: new URL(url).pathname, method: init.method })))
      .toStrictEqual(["GET", "PUT", "GET"].map(method => ({ path: "/api/v10/applications/100000000000000001/guilds/100000000000000002/commands", method })));
    expect(request.mock.calls[0]?.[0]).toContain("with_localizations=true");
    expect(request.mock.calls[1]?.[1].body).toBe(JSON.stringify(slashCommands));
    expect(request.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
  });
  it("does not use SDK retries for server errors", async () => {
    const request = vi.fn<RESTOptions["makeRequest"]>().mockResolvedValue(response({ message: "PRIVATE" }, 503));
    expect(await runCommandSync(settings, new AbortController().signal, input => createCommandRest(input, { makeRequest: request })))
      .toStrictEqual({ status: "failed", reason: "request_failed" });
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(["GET", "PUT"])("bounds a stalled %s request without retrying it", async method => {
    vi.useFakeTimers(); const reached = deferred<void>();
    const request = vi.fn<RESTOptions["makeRequest"]>().mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("controlled timeout", "AbortError")), { once: true });
      reached.resolve();
    }));
    if (method === "PUT") { request.mockResolvedValueOnce(response([])); }
    const pending = runCommandSync(settings, new AbortController().signal, input => createCommandRest(input, { makeRequest: request }));
    await reached.promise;
    await vi.advanceTimersByTimeAsync(SYNC_REQUEST_TIMEOUT_MS);
    expect(await pending).toStrictEqual({ status: method === "PUT" ? "unknown" : "failed", reason: "request_failed" });
    expect(request).toHaveBeenCalledTimes(method === "PUT" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a long 429 immediately instead of sleeping or retrying", async () => {
    const request = vi.fn<RESTOptions["makeRequest"]>().mockResolvedValue(response({ message: "PRIVATE", retry_after: 3600 }, 429, { "retry-after": "3600" }));
    expect(await runCommandSync(settings, new AbortController().signal, input => createCommandRest(input, { makeRequest: request })))
      .toStrictEqual({ status: "failed", reason: "rate_limited", retryAfterMs: 3_600_050 });
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not expose API error bodies, URLs or tokens", async () => {
    const request = vi.fn<RESTOptions["makeRequest"]>().mockResolvedValue(response({ message: "PRIVATE Authorization token", code: 50001 }, 401));
    expect(await runCommandSync(settings, new AbortController().signal, input => createCommandRest(input, { makeRequest: request })))
      .toStrictEqual({ status: "failed", reason: "request_failed" });
  });
});
