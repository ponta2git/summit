import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNotificationBody } from "../../src/notifications/http.body.ts";
import { RESULT_NOTIFICATION_BODY_TIMEOUT_MS, RESULT_NOTIFICATION_MAX_BODY_BYTES } from "../../src/notifications/config.ts";

describe("bounded notification request body", () => {
  afterEach(() => vi.useRealTimers());
  const request = (): IncomingMessage => new IncomingMessage(new Socket());

  it("preserves a UTF-8 body fragmented into individual bytes", async () => {
    const incoming = request();
    const reading = readNotificationBody(incoming);
    const text = JSON.stringify({ value: "あ😀".repeat(2_000) });
    for (const byte of Buffer.from(text)) { incoming.emit("data", Buffer.from([byte])); }
    incoming.emit("end");
    expect(await reading).toBe(text);
    expect(incoming.listenerCount("data")).toBe(0);
    expect(incoming.listenerCount("aborted")).toBe(0);
  });

  it("accepts exactly the byte ceiling and rejects an extra streamed byte without retaining listeners", async () => {
    for (const overflow of [false, true]) {
      const incoming = request();
      const reading = readNotificationBody(incoming).then(
        value => ({ status: "accepted", bytes: value.length }), (error: unknown) => ({ status: "rejected", error })
      );
      const chunk = Buffer.alloc(65_536, " ");
      for (let bytes = 0; bytes < RESULT_NOTIFICATION_MAX_BODY_BYTES; bytes += chunk.length) { incoming.emit("data", chunk); }
      if (overflow) { incoming.emit("data", Buffer.from("x")); }
      incoming.emit("end");
      expect(await reading).toMatchObject(overflow ? { status: "rejected", error: { status: 413, code: "payload_too_large" } }
        : { status: "accepted", bytes: RESULT_NOTIFICATION_MAX_BODY_BYTES });
      expect(incoming.listenerCount("data")).toBe(0);
      expect(incoming.listenerCount("end")).toBe(0);
    }
  });

  it.each(["timeout", "aborted"])("releases retained input and listeners after %s", async reason => {
    vi.useFakeTimers();
    const incoming = request();
    const reading = readNotificationBody(incoming).catch((error: unknown) => error);
    incoming.emit("data", Buffer.from("{"));
    if (reason === "timeout") { await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_BODY_TIMEOUT_MS); }
    else { incoming.emit("aborted"); }
    expect(await reading).toMatchObject({ code: reason === "timeout" ? "request_timeout" : "request_aborted" });
    expect(incoming.listenerCount("data")).toBe(0);
    expect(incoming.listenerCount("end")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
