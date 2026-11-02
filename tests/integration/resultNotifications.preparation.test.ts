import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { receiveResultNotification } from "../../src/db/repositories/resultNotifications.receipt.ts";
import { prepareResultReceipt } from "../../src/db/repositories/resultNotifications.prepare.ts";
import { NotificationInputError } from "../../src/domain/notificationInput.ts";
import { repositoryClock } from "./_notificationClock.ts";
import { checkNotificationAdmission, createResultNotificationHarness } from "./_resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { notificationNow as now } from "../contracts/resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("prepared receipt transactional precedence", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });

  it.each([new NotificationInputError("payload_too_large"), new Error("private admission diagnostic")])(
    "preserves duplicate/conflict behavior when today's new-admission check fails", async failure => {
      const base = analysisNotification(); const raw = JSON.stringify(base);
      await h.port.receive(raw, now);
      const check = vi.fn(() => { throw failure; }); const port = makeResultNotificationsPort(h.db, check, repositoryClock);
      expect(await port.receive(raw, now)).toMatchObject({ disposition: "duplicate", status: "PENDING" });
      await expect(port.receive(JSON.stringify({ ...base, data: { ...base.data, gameTitleName: "changed" } }), now))
        .rejects.toMatchObject({ code: "identity_conflict" });
      const changed = { ...base, sourceJobId: "new-job", notificationId: "result:analysis_completed:new-job" };
      const outcome = await port.receive(JSON.stringify(changed), now).catch(error => error);
      expect(outcome).toEqual(failure instanceof NotificationInputError ? new NotificationInputError("payload_too_large")
        : new Error("Notification database operation failed"));
      expect(check).toHaveBeenCalledTimes(3); expect(await h.countReceipts()).toBe(1);
    }
  );

  it.each(["{invalid", JSON.stringify({ ...analysisNotification(), schemaVersion: 9 })])(
    "keeps database unavailability ahead of a staged input error", async raw => {
      const transaction: typeof h.db.transaction = () => Promise.reject(new Error("database unavailable"));
      const unavailable = new Proxy(h.db, { get: (target, key, receiver) => key === "transaction" ? transaction : Reflect.get(target, key, receiver) });
      const port = makeResultNotificationsPort(unavailable, checkNotificationAdmission, repositoryClock);
      await expect(port.receive(raw, now)).rejects.toThrow("Notification database operation failed");
      expect(await h.countReceipts()).toBe(0);
    }
  );

  it("applies metadata errors only after the canonical size/hash stage", async () => {
    const base = analysisNotification(); const raw = JSON.stringify({ ...base, data: { ...base.data, currentAnalysis: {
      ...base.data.currentAnalysis, algorithmVersion: "x".repeat(256 * 1024)
    } } });
    const prepared = prepareResultReceipt(raw, checkNotificationAdmission);
    // Fault at the later metadata stage must not overtake the older JSONB budget check.
    const failure = { outcome: "unexpected", stage: "metadata" } as const;
    await expect(notificationTransaction(h.db, "result", tx => receiveResultNotification(tx, { ...prepared, newAdmission: failure }, now)))
      .rejects.toMatchObject({ code: "payload_too_large" });
    expect(await h.countReceipts()).toBe(0);
  });
});
