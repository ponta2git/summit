import { ChannelType, type MessageCreateOptions } from "discord.js";
import { vi } from "vitest";
import { createFakeResultNotificationsPort } from "../testing/ports.resultNotifications.ts";
import { ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { stubClient } from "./outboxWorker.harness.ts";
import { deliverResultNotification } from "../../src/scheduler/resultNotifications.delivery.ts";
import type { ClaimedResultNotification } from "../../src/db/ports.resultNotifications.ts";

export const resultWorkerHarness = () => {
  const clock = { now: () => new Date() };
  const port = createFakeResultNotificationsPort(clock);
  port.setTargetAvailable("match_draft", "draft-1", true);
  let messageCount = 0;
  const channel = { type: ChannelType.GuildText, isSendable: () => true,
    send: vi.fn(async (_body: MessageCreateOptions): Promise<{ id: string }> => ({ id: `message-${++messageCount}` })) };
  const client = stubClient(channel);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let stopping = false;
  const context = { channelId: "channel-1", webOrigin: "https://momo.example.com" };
  const deps = { port, clock, client, logger, context, isStopping: () => stopping };
  return { ...deps, channel, stop: () => { stopping = true; },
    enqueue: async (jobId = "job-1", summary = "長いメモ。".repeat(800)) => {
      const original = ocrReceiptPayload();
      const payload = { ...original, notificationId: `result:ocr_completed:${jobId}`, sourceJobId: jobId, data: { ...original.data, summary } };
      await port.receive(JSON.stringify(payload), clock.now()); return payload.notificationId;
    },
    claim: async () => {
      const [entry] = await port.claim({ limit: 1, now: clock.now(), claimDurationMs: 30_000 });
      if (!entry) { throw new Error("Expected claim"); }
      return entry;
    },
    deliver: (entry: ClaimedResultNotification) => deliverResultNotification(deps, entry)
  };
};
