import { describe, expect, it } from "vitest";

import { SLOT_KEYS, slotKeySchema } from "../src/slot.js";

describe("slot (domain)", () => {
  it("parses valid SlotKey values via zod schema", () => {
    for (const slotKey of SLOT_KEYS) {
      expect(slotKeySchema.parse(slotKey)).toBe(slotKey);
    }
  });

  it("rejects non-slot values in zod schema", () => {
    expect(slotKeySchema.safeParse("ABSENT").success).toBe(false);
    expect(slotKeySchema.safeParse("t2200").success).toBe(false);
  });
});
