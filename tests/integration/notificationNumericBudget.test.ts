import { beforeAll, describe, expect, it } from "vitest";
import { assertNotificationNumericBudget } from "../../src/domain/notificationNumericBudget.ts";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { createIntegrationDb, isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("numeric work budget against PostgreSQL output", () => {
  let database: ReturnType<typeof createIntegrationDb>;
  beforeAll(() => { database = createIntegrationDb(); });

  it("matches database output lengths across signs, zero scales, decimal shifts and large integer precision", async () => {
    const coefficients = ["0", "-0", "0.000000", "-0.00", "0.0000012", "1.2300", "-987654321000.0100", "9007199254740993.123456789000"];
    const numbers = coefficients.flatMap(coefficient => [-20, -3, -1, 0, 1, 3, 20].map(exponent => `${coefficient}e${exponent}`));
    const rows = await database.client<{ body: string }[]>`SELECT value::text AS body FROM jsonb_array_elements(${`[${numbers.join(",")}]`}::jsonb)`;
    expect(rows).toHaveLength(numbers.length);
    for (const [index, raw] of numbers.entries()) {
      const body = rows[index]?.body;
      if (!body) { throw new Error("Expected PostgreSQL numeric output"); }
      expect(() => assertNotificationNumericBudget(raw, body.length)).not.toThrow();
      expect(() => assertNotificationNumericBudget(raw, body.length - 1))
        .toThrow(body.length === 1 ? "Invalid notification numeric budget" : "payload_too_large");
      const normalized = await normalizeNotificationJson(database.db, raw, body.length);
      expect(normalized.text).toBe(body);
    }
  });

  it.each([["1e131071", 131_072], ["-1e131071", 131_073], ["1e-16383", 16_385], ["9.999e-16380", 16_385]])(
    "preserves the valid PostgreSQL numeric boundary %s", async (raw, bytes) => {
      const normalized = await normalizeNotificationJson(database.db, raw, bytes);
      expect(normalized.bytes).toBe(bytes);
      await expect(normalizeNotificationJson(database.db, raw, bytes - 1)).rejects.toMatchObject({ code: "payload_too_large" });
    }
  );

  it("keeps ordinary duplicate-key identity while rejecting excessive discarded-token work", async () => {
    const duplicate = await normalizeNotificationJson(database.db, '{"a":1e3,"a":-0.00}');
    const finalValue = await normalizeNotificationJson(database.db, '{"a":0}');
    expect(duplicate.hash).toBe(finalValue.hash);
    await expect(normalizeNotificationJson(database.db,
      '{"a":1e100000,"a":1e100000,"a":1e100000,"a":0}', 256 * 1024))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });
});
