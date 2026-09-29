import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capacityMetrics, capacityOptions, capacityTargetMet } from "../../scripts/verify/notificationCapacity.contract.ts";
import { capacityAnalysis } from "../../scripts/verify/notificationCapacity.fixtures.ts";
import { validateNewNotification } from "../../src/domain/resultNotificationPayload.ts";
import { planResultNotification } from "../../src/features/result-notifications/render.ts";

describe("notification capacity verification contract", () => {
  it("reports invalid CLI setup without loading runtime credentials or opening Docker", () => {
    const command = fileURLToPath(new URL("../../scripts/verify/notificationCapacity.ts", import.meta.url));
    const result = spawnSync(process.execPath, [command, "--invalid-image"], {
      env: {}, encoding: "utf8", timeout: 10_000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Notification capacity verification failed: setup_or_measurement.\n");
  });

  it("uses an explicit 256 MiB container and a separate 192 MiB headroom target", () => {
    expect(capacityOptions(["summit:capacity"])).toStrictEqual({
      image: "summit:capacity", memoryMiB: 256, targetMiB: 192, scenario: "all"
    });
    expect(capacityOptions(["summit:capacity", "--scenario", "legacy", "--memory-mib", "512", "--target-mib", "384"]))
      .toStrictEqual({ image: "summit:capacity", memoryMiB: 512, targetMiB: 384, scenario: "legacy" });
  });

  it.each([
    [], ["--privileged"], ["summit:capacity", "--memory-mib"], ["summit:capacity", "--memory-mib", "0"],
    ["summit:capacity", "--scenario", "production"], ["summit:capacity", "--target-mib", "256"],
    ["summit:capacity", "--target-mib", "190", "--target-mib", "192"],
    ["summit:capacity", "--memory-mib", "9007199254740992"], ["summit:capacity", "--privileged", "true"]
  ].map(args => ({ args })))("rejects malformed or ambiguous harness arguments: $args", ({ args }) => {
    expect(() => capacityOptions(args)).toThrow("setup_or_measurement");
  });

  it("fails the target at one byte over the cgroup limit, independently of sampled RSS", () => {
    const metrics = capacityMetrics.parse({ baselineRss: 100, peakRss: 120, maxRss: 130,
      cgroupPeak: 192 * 1024 * 1024, received: 17, sentParts: 20, deliveredNotifications: 17,
      pendingSends: 0, pendingReceipts: 0, maxPendingSends: 2, maxPendingReceipts: 2,
      maxClaimBatchBytes: 512 * 1024, maxClaimBatchCount: 2, protocolFailures: 0 });
    expect(capacityTargetMet(metrics, 192)).toBe(true);
    expect(capacityTargetMet({ ...metrics, cgroupPeak: metrics.cgroupPeak + 1 }, 192)).toBe(false);
    expect(capacityMetrics.safeParse({ ...metrics, cgroupPeak: Number.NaN }).success).toBe(false);
    expect(capacityMetrics.safeParse({ ...metrics, protocolFailures: 1 }).success).toBe(false);
    expect(capacityMetrics.safeParse({ ...metrics, cgroupPeak: undefined }).success).toBe(false);
  });

  it.each(["unicode", "markdown"] as const)("fills accepted semantic boundaries with %s and renders every part", mode => {
    const value = capacityAnalysis(`capacity-${mode}`, mode);
    expect(validateNewNotification(value)).toStrictEqual(value);
    expect(value.data.matches).toHaveLength(50);
    expect(value.data.seasons).toHaveLength(16);
    expect([...value.data.gameTitleName]).toHaveLength(256);
    expect([...value.data.matches[0]!.players[0].displayName]).toHaveLength(32);
    expect([...value.data.matches[0]!.note!]).toHaveLength(150);
    const plan = planResultNotification(value, "https://results.example.com");
    expect(plan.partCount).toBeGreaterThan(50);
    expect(plan.partCount).toBeLessThanOrEqual(128);
    const parts = [...plan.parts()];
    expect(parts).toHaveLength(plan.partCount);
    expect(parts.every(part => part.content.length <= 2_000)).toBe(true);
    expect(parts.at(-1)?.content).toContain("最新の分析を確認:");
  });
});
