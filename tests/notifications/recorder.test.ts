import { describe, expect, it } from "vitest";
import { requireRecorderDatabase } from "../../scripts/dev/resultNotificationRecorder.config.ts";

describe("record-only notification runtime guard", () => {
  it("accepts only an explicitly named loopback disposable database", () => {
    expect(requireRecorderDatabase("postgres://localhost:55432/mom24_run").pathname).toBe("/mom24_run");
    for (const input of [undefined, "not a database URL", "postgres://localhost/summit", "postgres://remote.example/mom24_run", "https://localhost/mom24_run"]) {
      expect(() => requireRecorderDatabase(input)).toThrow(/TEST_DATABASE_URL|Recorder requires/);
    }
  });
});
