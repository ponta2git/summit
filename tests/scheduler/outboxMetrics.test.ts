// why: outbox observability metrics (ADR-0043) の depth/age snapshot と warn 昇格条件を fake port 経由で検証。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxEntry } from "../../src/db/ports.js";
import {
  OUTBOX_METRICS_PENDING_AGE_WARN_MS,
  OUTBOX_METRICS_PENDING_WARN_DEPTH
} from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { runOutboxMetricsTick } from "../../src/scheduler/outboxMetrics.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

const baseEntry = (
  overrides: Partial<OutboxEntry> &
    Pick<OutboxEntry, "id" | "sessionId" | "dedupeKey" | "status">
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
  nextAttemptAt: new Date("2026-04-25T00:00:00Z"),
  deliveredAt: null,
  deliveredMessageId: null,
  createdAt: new Date("2026-04-25T00:00:00Z"),
  updatedAt: new Date("2026-04-25T00:00:00Z"),
  ...overrides
});

describe("runOutboxMetricsTick", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("emits info-level metrics when no thresholds are exceeded", async () => {
    const session = buildSessionRow({ id: "sm1" });
    const now = new Date("2026-04-25T01:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "p1",
        sessionId: session.id,
        dedupeKey: "p1",
        status: "PENDING",
        createdAt: new Date(now.getTime() - 30_000)
      })
    );
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runOutboxMetricsTick(ctx);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const fields = info.mock.calls[0]?.[0];
    expect(fields).toMatchObject({
      event: "outbox.metrics",
      pending: 1,
      inFlight: 0,
      failed: 0
    });
  });

  // invariant: failed > 0 のみで warn に昇格する (ADR-0043)。
  it("escalates to warn when any FAILED row is present", async () => {
    const session = buildSessionRow({ id: "sm2" });
    const now = new Date("2026-04-25T01:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "f1",
        sessionId: session.id,
        dedupeKey: "f1",
        status: "FAILED",
        updatedAt: new Date(now.getTime() - 60_000)
      })
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await runOutboxMetricsTick(ctx);

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "outbox.metrics",
      failed: 1,
      oldestFailedAgeMs: 60_000
    });
  });

  it("escalates to warn when oldest pending age exceeds threshold", async () => {
    const session = buildSessionRow({ id: "sm3" });
    const now = new Date("2026-04-25T01:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    ctx.ports.outbox.seedEntry(
      baseEntry({
        id: "p1",
        sessionId: session.id,
        dedupeKey: "p1",
        status: "PENDING",
        createdAt: new Date(now.getTime() - OUTBOX_METRICS_PENDING_AGE_WARN_MS - 1)
      })
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await runOutboxMetricsTick(ctx);

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("escalates to warn when pending depth exceeds threshold", async () => {
    const session = buildSessionRow({ id: "sm4" });
    const now = new Date("2026-04-25T01:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    for (let i = 0; i <= OUTBOX_METRICS_PENDING_WARN_DEPTH; i += 1) {
      ctx.ports.outbox.seedEntry(
        baseEntry({
          id: `p${i}`,
          sessionId: session.id,
          dedupeKey: `p${i}`,
          status: "PENDING",
          createdAt: new Date(now.getTime() - 1_000)
        })
      );
    }
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runOutboxMetricsTick(ctx);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      pending: OUTBOX_METRICS_PENDING_WARN_DEPTH + 1
    });
  });

  it("emits zero-depth baseline at info level when outbox is empty", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-25T01:00:00Z") });
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await runOutboxMetricsTick(ctx);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      pending: 0,
      inFlight: 0,
      failed: 0,
      oldestPendingAgeMs: null,
      oldestFailedAgeMs: null
    });
  });
});
