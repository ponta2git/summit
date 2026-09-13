import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { databaseUrl, dropOwnedDatabase, newDatabasePrefix, requireLocalTestUrl } from "../integration/databaseLifecycle.ts";

describe("disposable database ownership", () => {
  it("rejects missing, malformed, remote and host-override URLs without echoing credentials", () => {
    for (const input of [undefined, "private-value", "postgres://private-value@example.test/db",
      "https://localhost/db", "postgres://localhost/db?host=example.test", "postgres://localhost/db#override"]) {
      expect(() => requireLocalTestUrl(input)).toThrow(/TEST_DATABASE_URL/);
      const errorMessage = () => {
        try { requireLocalTestUrl(input); return ""; } catch (error) { return String(error); }
      };
      expect(errorMessage()).not.toContain("private-value");
    }
  });
  it("creates separate run identities and derives database URLs without changing the server", () => {
    const a = newDatabasePrefix(); const b = newDatabasePrefix();
    expect(a).toMatch(/^summit_test_[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
    expect(databaseUrl("postgres://test:test@[::1]:5432/admin", `${a}_template`))
      .toBe(`postgres://test:test@[::1]:5432/${a}_template`);
  });
  it("refuses cleanup of arbitrary names before opening any connection", async () => {
    const client = postgres("postgres://test:test@localhost:1/test");
    const prefix = newDatabasePrefix();
    try {
      for (const name of ["summit", prefix, `${newDatabasePrefix()}_template`, `${prefix}_x; DROP DATABASE summit`]) {
        await expect(dropOwnedDatabase(client, name, prefix)).rejects.toThrow("outside this test run");
      }
    } finally { await client.end(); }
  });
});
