import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../../scripts/dev/localDatabase.ts";

describe("development database target guard", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "postgres"])("accepts the documented local host %s", host => {
    expect(() => assertLocalDatabase(`postgres://test:test@${host}:5432/dev`)).not.toThrow();
  });
  it.each([
    "postgres://test:dummy-private-value@remote.example/dev",
    "http://localhost/dev", "postgres://localhost,remote.example/dev", "dummy-private-value"
  ])("rejects unsafe or malformed targets without echoing input (%#)", value => {
    let failure: unknown;
    try { assertLocalDatabase(value); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(value);
    expect(String(failure)).not.toContain("dummy-private-value");
  });
});
