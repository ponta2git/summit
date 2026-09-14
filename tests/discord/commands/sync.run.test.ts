import { HTTPError, RateLimitError } from "@discordjs/rest";
import { describe, expect, it, vi } from "vitest";
import { slashCommands } from "../../../src/commands/definitions.ts";
import { runCommandSync } from "../../../src/commands/sync.run.ts";
import { deferred } from "../../helpers/deferred.ts";

const settings = { production: true, check: false, token: "controlled-dummy-token", applicationId: "100000000000000001", guildId: "100000000000000002" };
const makeRest = () => ({ read: vi.fn<(signal: AbortSignal) => Promise<unknown>>().mockResolvedValue(slashCommands),
  overwrite: vi.fn<(signal: AbortSignal) => Promise<unknown>>().mockResolvedValue(slashCommands), dispose: vi.fn() });
const rateLimit = () => new RateLimitError({ global: true, hash: "test", limit: 1, majorParameter: "PRIVATE", method: "PUT",
  retryAfter: 5000, route: "/applications/:id/guilds/:id/commands", scope: "user", sublimitTimeout: 0, timeToReset: 5000, url: "https://discord.com/PRIVATE" });

describe("standalone command synchronization", () => {
  it("does no write when registration already matches", async () => {
    const rest = makeRest();
    expect(await runCommandSync(settings, new AbortController().signal, () => rest)).toStrictEqual({ status: "matched" });
    expect(rest.overwrite).not.toHaveBeenCalled();
    expect(rest.dispose).toHaveBeenCalledOnce();
  });
  it("checks differences without writing", async () => {
    const rest = makeRest(); rest.read.mockResolvedValue([]);
    expect(await runCommandSync({ ...settings, check: true }, new AbortController().signal, () => rest)).toStrictEqual({ status: "different" });
    expect(rest.overwrite).not.toHaveBeenCalled();
  });
  it("overwrites exactly once and requires a matching read-back", async () => {
    const rest = makeRest(); rest.read.mockResolvedValueOnce([]).mockResolvedValueOnce(slashCommands);
    const pending = deferred<unknown>(); const writing = deferred<void>();
    rest.overwrite.mockImplementation(() => { writing.resolve(); return pending.promise; });
    const result = runCommandSync(settings, new AbortController().signal, () => rest);
    await writing.promise;
    expect(rest.read).toHaveBeenCalledTimes(1);
    pending.resolve(slashCommands);
    expect(await result).toStrictEqual({ status: "synced" });
    expect(rest.read).toHaveBeenCalledTimes(2);
    expect(rest.dispose).toHaveBeenCalledOnce();
  });
  it("does not overwrite if the initial response is invalid", async () => {
    const rest = makeRest(); rest.read.mockResolvedValue({ private: "PRIVATE" });
    expect(await runCommandSync(settings, new AbortController().signal, () => rest)).toStrictEqual({ status: "failed", reason: "invalid_response" });
    expect(rest.overwrite).not.toHaveBeenCalled();
  });
  it("reports uncertainty without retrying a failed PUT", async () => {
    const rest = makeRest(); rest.read.mockResolvedValue([]); rest.overwrite.mockRejectedValue(new Error("PRIVATE Authorization token"));
    expect(await runCommandSync(settings, new AbortController().signal, () => rest)).toStrictEqual({ status: "unknown", reason: "request_failed" });
    expect(rest.overwrite).toHaveBeenCalledOnce(); expect(rest.dispose).toHaveBeenCalledOnce();
  });
  it("reports a confirmed HTTP rejection differently from an uncertain write", async () => {
    const rest = makeRest(); rest.read.mockResolvedValue([]);
    rest.overwrite.mockRejectedValue(new HTTPError(403, "PRIVATE", "PUT", "https://discord.com/PRIVATE", {}));
    expect(await runCommandSync(settings, new AbortController().signal, () => rest)).toStrictEqual({ status: "failed", reason: "request_failed" });
  });
  it("fails promptly on rate limits and exposes only the retry delay", async () => {
    const rest = makeRest(); rest.read.mockResolvedValue([]); rest.overwrite.mockRejectedValue(rateLimit());
    expect(await runCommandSync(settings, new AbortController().signal, () => rest)).toStrictEqual({ status: "failed", reason: "rate_limited", retryAfterMs: 5000 });
    expect(rest.overwrite).toHaveBeenCalledOnce();
  });
  it.each([[], rateLimit()].map(response => ({ response })))("keeps a write uncertain when verification fails", async ({ response }) => {
    const rest = makeRest(); rest.read.mockResolvedValueOnce([]);
    if (response instanceof Error) { rest.read.mockRejectedValueOnce(response); } else { rest.read.mockResolvedValueOnce(response); }
    const report = await runCommandSync(settings, new AbortController().signal, () => rest);
    expect(report.status).toBe("unknown"); expect(rest.overwrite).toHaveBeenCalledOnce();
  });
  it.each([[], slashCommands].map(registered => ({ registered })))("honors cancellation before reporting a precheck or writing", async ({ registered }) => {
    const controller = new AbortController(); const rest = makeRest();
    rest.read.mockImplementation(async () => { controller.abort(); return registered; });
    expect(await runCommandSync(settings, controller.signal, () => rest)).toStrictEqual({ status: "failed", reason: "cancelled" });
    expect(rest.overwrite).not.toHaveBeenCalled();
  });
  it("does not report success if verification was cancelled after a write", async () => {
    const controller = new AbortController(); const rest = makeRest();
    rest.read.mockResolvedValueOnce([]).mockImplementation(async () => { controller.abort(); return slashCommands; });
    expect(await runCommandSync(settings, controller.signal, () => rest)).toStrictEqual({ status: "unknown", reason: "cancelled" });
    expect(rest.overwrite).toHaveBeenCalledOnce(); expect(rest.dispose).toHaveBeenCalledOnce();
  });
});
