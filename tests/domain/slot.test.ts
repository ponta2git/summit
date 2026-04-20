import { describe, expect, it } from "vitest";

import {
  CUSTOM_ID_SLOT_CHOICES,
  SLOT_KEYS,
  customIdChoiceFromSlotKey,
  dbChoiceFromSlotKey,
  slotKeyFromCustomIdChoice,
  slotKeyFromDbChoice,
  slotKeySchema
} from "../../src/domain/slot.js";

describe("domain slot", () => {
  it("parses valid SlotKey values via zod schema", () => {
    for (const slotKey of SLOT_KEYS) {
      expect(slotKeySchema.parse(slotKey)).toBe(slotKey);
    }
  });

  it("rejects non-slot values in zod schema", () => {
    expect(slotKeySchema.safeParse("ABSENT").success).toBe(false);
    expect(slotKeySchema.safeParse("t2200").success).toBe(false);
  });

  it("converts custom_id slot choices to SlotKey and back", () => {
    for (const choice of CUSTOM_ID_SLOT_CHOICES) {
      const slotKey = slotKeyFromCustomIdChoice(choice);
      expect(customIdChoiceFromSlotKey(slotKey)).toBe(choice);
    }
  });

  it("converts DB slot choices to SlotKey and back", () => {
    for (const slotKey of SLOT_KEYS) {
      const fromDb = slotKeyFromDbChoice(slotKey);
      expect(dbChoiceFromSlotKey(fromDb)).toBe(slotKey);
    }
  });
});
