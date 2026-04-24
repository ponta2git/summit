// why: outbox retention worker (ADR-0042) の prune 振る舞いを fake port 経由で検証する。
//   real repository は同 port 契約 (ports.ts) を満たすため、ここでのカバレッジが production 挙動の保証。

import { describe, expect, it } from "vitest";

import type { OutboxEntry } from "../../src/db/ports.js";
import {
  OUTBOX_RETENTION_DELIVERED_MS,
  OUTBOX_RETENTION_FAILED_MS
} from "../../src/config.js";
import { runOutboxRetentionTick } from "../../src/scheduler/outboxRetention.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

const baseEntry = (
  overrides: Partial<OutboxEntry> & Pick<OutboxEntry, "id" | "sessionId" | "dedupeKey" | "status">
): OutboxEntry => ({
  kind: "send_message",
  payload: {
    kind: "send_message",
    channelId: "c1",
    renderer: "x",
    extra: { content: "x" }
  },
  attemptCount: 0,
  lastError: null,
  claimExpiresAt: null,
  nextAttemptAt: new Date("2026-04-01T00:00:00Z"),
  deliveredAt: null,
  deliveredMessageId: null,
  createdAt: new Date("2026-04-01T00:00:00Z"),
  updatedAt: new Date("2026-04-01T00:00:00Z"),
  ...overrides
});

describe("runOutboxRetentionTick", () => {
  it("prunes DELIVERED past retention and FAILED past retention; keeps PENDING/IN_FLIGHT and recent terminals", async () => {
    const session = buildSessionRow({ id: "sret" });
    const now = new Date("2026-05-01T04:00:00Z");
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now
    });

    const oldDelivered = new Date(now.getTime() - OUTBOX_RETENTION_DELIVERED_MS - 1);
    const recentDelivered = new Date(now.getTime() - 60_000);
    const oldFailed = new Date(now.getTime() - OUTBOX_RETENTION_FAILED_MS - 1);
    const recentFailed = new Date(now.getTime() - 60_000);

    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "old-del",
        sessionId: session.id,
        dedupeKey: "old-del",
        status: "DELIVERED",
        deliveredAt: oldDelivered,
        updatedAt: oldDelivered
      })
    );
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "recent-del",
        sessionId: session.id,
        dedupeKey: "recent-del",
        status: "DELIVERED",
        deliveredAt: recentDelivered,
        updatedAt: recentDelivered
      })
    );
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "old-failed",
        sessionId: session.id,
        dedupeKey: "old-failed",
        status: "FAILED",
        updatedAt: oldFailed
      })
    );
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "recent-failed",
        sessionId: session.id,
        dedupeKey: "recent-failed",
        status: "FAILED",
        updatedAt: recentFailed
      })
    );
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "ancient-pending",
        sessionId: session.id,
        dedupeKey: "ancient-pending",
        status: "PENDING",
        updatedAt: new Date("2025-01-01T00:00:00Z")
      })
    );
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "ancient-inflight",
        sessionId: session.id,
        dedupeKey: "ancient-inflight",
        status: "IN_FLIGHT",
        updatedAt: new Date("2025-01-01T00:00:00Z"),
        claimExpiresAt: new Date("2025-01-01T00:01:00Z")
      })
    );

    await runOutboxRetentionTick(ctx);

    const remaining = ctx.ports.outbox.listEntries().map((e) => e.id);
    expect(remaining).not.toContain("old-del");
    expect(remaining).not.toContain("old-failed");
    expect(remaining).toContain("recent-del");
    expect(remaining).toContain("recent-failed");
    // invariant: PENDING / IN_FLIGHT は経過時間に関わらず絶対に prune しない (ADR-0042)。
    expect(remaining).toContain("ancient-pending");
    expect(remaining).toContain("ancient-inflight");
  });

  it("is a no-op when no terminal rows exceed retention", async () => {
    const session = buildSessionRow({ id: "sret2" });
    const now = new Date("2026-05-01T04:00:00Z");
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now
    });
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "p1",
        sessionId: session.id,
        dedupeKey: "p1",
        status: "PENDING"
      })
    );

    await runOutboxRetentionTick(ctx);

    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
  });
});
