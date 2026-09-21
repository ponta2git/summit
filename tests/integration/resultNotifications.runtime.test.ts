import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createResultNotificationRecorder, type RecordedNotification } from "../../scripts/dev/resultNotificationRecorder.runtime.ts";
import { ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { receiverToken, operationsToken } from "../notifications/http.harness.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("result notification runtime with real PostgreSQL", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  let runtime: ReturnType<typeof createResultNotificationRecorder> | undefined;
  beforeEach(async () => { h = await createResultNotificationHarness(); });
  afterEach(async () => { runtime?.stop(); await runtime?.drain(); });

  it("receives, persists OCR v2, renders once and records delivery without Discord login", async () => {
    const messages: RecordedNotification[] = [];
    runtime = createResultNotificationRecorder({ db: h.db, token: receiverToken, operationsToken,
      webOrigin: "https://momo.example.test", record: async message => { messages.push(message); } });
    await runtime.start();
    const address = runtime.address();
    expect(address?.address).toBe("127.0.0.1");
    const payload = ocrReceiptPayload();
    payload.data = { ...payload.data, failures: [{ screenType: "revenue", reason: "ocr_failed" }] };
    const response = await fetch(`http://127.0.0.1:${address?.port}/internal/discord-notifications`, {
      method: "POST", headers: { authorization: `Bearer ${receiverToken}`, "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    expect(response.status).toBe(202);
    // The observed DB terminal state is the barrier; no guessed delivery delay is used.
    await expect.poll(async () => (await h.port.inspect(payload.notificationId))?.status).toBe("DELIVERED");
    const [row] = await h.client`SELECT schema_version, renderer_version, part_count FROM discord_notifications WHERE id = ${payload.notificationId}`;
    expect({ ...row }).toStrictEqual({ schema_version: 2, renderer_version: 2, part_count: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channelId).toBe("recorded-channel");
    expect(messages[0]?.body.content).toContain("物件収益: 画像を読み取れませんでした。");
    expect(messages[0]?.body.content).not.toMatch(/成功|要確認/);
    expect(messages[0]?.body.content).toContain("<https://momo.example.test/review/draft-1>");
    expect(messages[0]?.body.allowedMentions).toStrictEqual({ parse: [], users: [], roles: [], repliedUser: false });
    runtime.stop(); await runtime.drain();
    await setImmediate();
    expect(messages).toHaveLength(1);
  });
});
