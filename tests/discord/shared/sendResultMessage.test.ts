import { RESTEvents } from "@discordjs/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendResultMessage } from "../../../src/discord/shared/sendResultMessage.ts";
import { RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../../../src/notifications/config.ts";
import { deferred } from "../../helpers/deferred.ts";
import { destroyResultMessageClients, restResponse, resultMessageRestHarness } from "./sendResultMessage.harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    await destroyResultMessageClients();
    if (vi.getTimerCount() !== 0) { throw new Error("Offline Discord client left pending timers"); }
  }
  finally { vi.useRealTimers(); }
});

describe("result messages through the real SDK and an offline REST transport", () => {
  it.each([0, 12, 200])("releases result messages with %i ordinary messages already cached", async ordinaryCount => {
    const h = await resultMessageRestHarness();
    const ordinaryIds: string[] = [];
    for (let index = 0; index < ordinaryCount; index++) {
      ordinaryIds.push((await h.channel.send({ content: `attendance-${index}` })).id);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.channel.messages.cache.size).toBe(ordinaryCount);
    const resultIds: string[] = [];
    for (let index = 0; index < 220; index++) {
      const id = await sendResultMessage(h.channel, {
        content: `result-${index}`, nonce: String(index), enforceNonce: true, allowedMentions: { parse: [] }
      });
      resultIds.push(id);
      expect(h.channel.messages.cache.has(id)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // why: 満杯ならSDKの追加時に最古1件が先にevictされる。局所deleteはそれを復元しない。
    const retained = ordinaryCount === 200 ? ordinaryIds.slice(1) : ordinaryIds;
    expect([...h.channel.messages.cache.keys()]).toStrictEqual(retained);
    expect(resultIds.every(id => typeof id === "string")).toBe(true);
    expect(h.post.mock.calls.at(-1)?.[0]).toMatchObject({ content: "result-219", nonce: "219", enforce_nonce: true });
    expect(h.request.mock.calls.every(([url]) => new URL(url).hostname === "discord.com")).toBe(true);
  });

  it("keeps the default bounded cache for more than 200 ordinary attendance messages", async () => {
    const h = await resultMessageRestHarness();
    const resultId = await sendResultMessage(h.channel, { content: "result" });
    const ordinaryIds: string[] = [];
    for (let index = 0; index < 205; index++) {
      ordinaryIds.push((await h.channel.send({ content: `attendance-${index}` })).id);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.channel.messages.cache.size).toBe(200);
    expect([...h.channel.messages.cache.keys()]).toStrictEqual(ordinaryIds.slice(-200));
    expect(h.channel.messages.cache.has(resultId)).toBe(false);
    expect(h.channel.messages.cache.last()?.content).toBe("attendance-204");
  });

  it("does not increase attendance message GETs compared with direct SDK sends for warm or full caches", async () => {
    for (const ordinaryCount of [12, 200]) {
      const reads: number[] = [];
      for (const releaseResult of [false, true]) {
        const h = await resultMessageRestHarness();
        let ordinaryId = "";
        for (let index = 0; index < ordinaryCount; index++) {
          ordinaryId = (await h.channel.send({ content: `attendance-${index}` })).id;
          await vi.advanceTimersByTimeAsync(1000);
        }
        const readCount = () => h.request.mock.calls.filter(([url, init]) =>
          init.method === "GET" && new URL(url).pathname.endsWith(`/messages/${ordinaryId}`)).length;
        expect((await h.channel.messages.fetch(ordinaryId)).content).toBe(`attendance-${ordinaryCount - 1}`);
        expect(readCount()).toBe(0);
        for (let index = 0; index < 220; index++) {
          const body = { content: `result-${index}` };
          if (releaseResult) { await sendResultMessage(h.channel, body); } else { await h.channel.send(body); }
          await vi.advanceTimersByTimeAsync(1000);
        }
        expect((await h.channel.messages.fetch(ordinaryId)).content).toBe(`attendance-${ordinaryCount - 1}`);
        reads.push(readCount());
      }
      expect(reads).toStrictEqual([1, 0]);
    }
  });

  it("does not turn cache cleanup failure into a failed send or retry", async () => {
    const h = await resultMessageRestHarness();
    vi.spyOn(h.channel.messages.cache, "delete").mockImplementationOnce(() => { throw new Error("cache cleanup failed"); });
    const id = await sendResultMessage(h.channel, { content: "accepted by Discord" });
    expect(h.channel.messages.cache.get(id)?.content).toBe("accepted by Discord");
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("preserves SDK retry behavior and removes the eventual successful result", async () => {
    const h = await resultMessageRestHarness();
    h.post.mockResolvedValueOnce(restResponse({ message: "temporary failure" }, 503));
    const id = await sendResultMessage(h.channel, { content: "retry result" });
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.channel.messages.cache.has(id)).toBe(false);
  });

  it("propagates a failed send without deleting an ordinary cached message", async () => {
    const h = await resultMessageRestHarness();
    const ordinary = await h.channel.send({ content: "attendance" });
    const remove = vi.spyOn(h.channel.messages.cache, "delete");
    h.post.mockResolvedValueOnce(restResponse({ message: "Missing Access", code: 50001 }, 403));
    await expect(sendResultMessage(h.channel, { content: "rejected result" })).rejects.toMatchObject({ status: 403 });
    expect(remove).not.toHaveBeenCalled();
    expect(h.channel.messages.cache.get(ordinary.id)).toBe(ordinary);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("cleans up late 429 completions even after application waits expire and SDK work remains queued", async () => {
    const h = await resultMessageRestHarness();
    const ordinary = await h.channel.send({ content: "attendance" });
    const limited = deferred<void>();
    h.client.rest.once(RESTEvents.RateLimited, () => limited.resolve());
    h.post.mockResolvedValueOnce(restResponse({ message: "rate limited", retry_after: 60, global: true }, 429,
      { "retry-after": "60", "x-ratelimit-global": "true" }));
    let completed = 0;
    const send = (content: string) => sendResultMessage(h.channel, { content }).then(id => { completed++; return id; });
    const pending = [send("first result"), send("second result")];
    const expired = deferred<"application timeout">();
    const timer = setTimeout(() => expired.resolve("application timeout"), RESULT_NOTIFICATION_SEND_TIMEOUT_MS);
    const waits = pending.map(result => Promise.race([result, expired.promise]));
    try {
      await limited.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS);
      expect(await Promise.all(waits)).toStrictEqual(["application timeout", "application timeout"]);
      pending.push(send("third result"));
      expect(completed).toBe(0);
      expect(h.post).toHaveBeenCalledTimes(2); // attendance成功と最初の429だけがtransportへ到達。
      await vi.advanceTimersByTimeAsync(16_000);
      const ids = await Promise.all(pending);
      expect(completed).toBe(3);
      expect(ids.every(id => !h.channel.messages.cache.has(id))).toBe(true);
      expect([...h.channel.messages.cache.keys()]).toStrictEqual([ordinary.id]);
      expect(h.post).toHaveBeenCalledTimes(5);
    } finally {
      clearTimeout(timer);
      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.allSettled(pending);
    }
  });
});
