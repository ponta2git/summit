import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
describe("maintenance startup boundary", () => {
  it.each([
    { MOMO_CUTOVER_MODE: "invalid" },
    { MOMO_CUTOVER_EXPECTED_ROLE: "leftover" },
    { MOMO_CUTOVER_MODE: "", MOMO_CUTOVER_REPORT_PATH: "/tmp/leftover" }
  ])("rejects ambiguous modes without importing the business runtime", env => {
    const result = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("CUTOVER_MODE_INVALID\n");
  });
  it("fails closed when maintenance identity is missing", () => {
    const result = spawnSync(process.execPath, [entry], {
      env: { MOMO_CUTOVER_MODE: "maintenance" }, encoding: "utf8", timeout: 5000
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("MAINTENANCE_FAILED\n");
  });
});
