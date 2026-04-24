import { describe, expect, it } from "vitest";

import {
  buildCancelWeekCustomId,
  buildCustomId,
  CUSTOM_ID_SLOT_CHOICES,
  customIdChoiceFromSlotKey,
  parseCancelWeekCustomId,
  parseCustomId,
  slotKeyFromCustomIdChoice
} from "../../src/discord/shared/customId.js";
import { SLOT_KEYS } from "../../src/slot.js";
import { expectParseFailure, expectParseSuccess } from "../helpers/assertions.js";

describe("customId codec", () => {
  const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";

  it("parses valid ask custom id", () => {
    const parsed = parseCustomId(`ask:${sessionId}:t2230`);

    expect(expectParseSuccess(parsed)).toStrictEqual({
      kind: "ask",
      sessionId,
      choice: "t2230"
    });
  });

  it("parses valid postpone custom id", () => {
    const parsed = parseCustomId(`postpone:${sessionId}:ok`);

    expect(expectParseSuccess(parsed)).toStrictEqual({
      kind: "postpone",
      sessionId,
      choice: "ok"
    });
  });

  it("rejects invalid prefix", () => {
    const parsed = parseCustomId(`vote:${sessionId}:ok`);
    expectParseFailure(parsed);
  });

  it("rejects invalid uuid", () => {
    const parsed = parseCustomId("ask:not-a-uuid:t2200");
    expectParseFailure(parsed);
  });

  it("rejects invalid choice", () => {
    const parsed = parseCustomId(`postpone:${sessionId}:maybe`);
    expectParseFailure(parsed);
  });

  it("keeps round-trip identity on valid inputs", () => {
    const raw = `ask:${sessionId}:absent`;
    const parsed = parseCustomId(raw);

    expect(buildCustomId(expectParseSuccess(parsed))).toBe(raw);
  });
});

describe("slot wire in custom_id", () => {
  it("round-trips SlotKey through customId choice", () => {
    for (const slotKey of SLOT_KEYS) {
      const choice = customIdChoiceFromSlotKey(slotKey);
      expect(CUSTOM_ID_SLOT_CHOICES).toContain(choice);
      expect(slotKeyFromCustomIdChoice(choice)).toBe(slotKey);
    }
  });
});

describe("cancel_week customId codec", () => {
  const nonce = "d8b1f8e5-1111-4222-8333-123456789abc";

  it("parses valid confirm id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:confirm`);
    expect(expectParseSuccess(parsed)).toStrictEqual({ kind: "cancel_week", nonce, choice: "confirm" });
  });

  it("parses valid abort id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:abort`);
    expect(expectParseSuccess(parsed)).toStrictEqual({ kind: "cancel_week", nonce, choice: "abort" });
  });

  it("rejects wrong prefix", () => {
    const parsed = parseCancelWeekCustomId(`cancel:${nonce}:confirm`);
    expectParseFailure(parsed);
  });

  it("rejects invalid uuid nonce", () => {
    const parsed = parseCancelWeekCustomId("cancel_week:not-a-uuid:confirm");
    expectParseFailure(parsed);
  });

  it("rejects unknown choice", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:maybe`);
    expectParseFailure(parsed);
  });

  it("rejects wrong segment count", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:confirm:extra`);
    expectParseFailure(parsed);
  });

  it("keeps round-trip identity on valid inputs", () => {
    const raw = `cancel_week:${nonce}:confirm`;
    const parsed = parseCancelWeekCustomId(raw);
    expect(buildCancelWeekCustomId(expectParseSuccess(parsed))).toBe(raw);
  });
});
