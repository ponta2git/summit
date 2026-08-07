import { describe, expect, it } from "vitest";

import { slotKeySchema } from "../src/slot.js";

describe("slot (domain)", () => {
  it("accepts exactly the four domain SlotKey values", () => {
    const slotKeys = ["T2200", "T2230", "T2300", "T2330"] as const;
    expect(slotKeySchema.options).toStrictEqual(slotKeys);
    for (const slotKey of slotKeys) {
      expect(slotKeySchema.parse(slotKey)).toBe(slotKey);
    }
  });

  it("rejects non-slot values in zod schema", () => {
    expect(slotKeySchema.safeParse("ABSENT").success).toBe(false);
    expect(slotKeySchema.safeParse("t2200").success).toBe(false);
  });
});
