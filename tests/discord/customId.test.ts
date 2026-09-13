import { describe, expect, it } from "vitest";

import {
  buildCancelWeekCustomId,
  buildCustomId,
  parseCancelWeekCustomId,
  parseCustomId,
  slotKeyFromCustomIdChoice
} from "../../src/discord/shared/customId.js";
import { expectParseSuccess } from "../helpers/assertions.js";

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
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid uuid", () => {
    const parsed = parseCustomId("ask:not-a-uuid:t2200");
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid choice", () => {
    const parsed = parseCustomId(`postpone:${sessionId}:maybe`);
    expect(parsed.success).toBe(false);
  });

  it("keeps round-trip identity on valid inputs", () => {
    const raw = `ask:${sessionId}:absent`;
    const parsed = parseCustomId(raw);

    expect(buildCustomId(expectParseSuccess(parsed))).toBe(raw);
  });
});

describe("slot wire in custom_id", () => {
  it("maps customId choices to SlotKey", () => {
    expect(slotKeyFromCustomIdChoice("t2200")).toBe("T2200");
    expect(slotKeyFromCustomIdChoice("t2230")).toBe("T2230");
    expect(slotKeyFromCustomIdChoice("t2300")).toBe("T2300");
    expect(slotKeyFromCustomIdChoice("t2330")).toBe("T2330");
  });
});

describe("cancel_week customId codec", () => {
  const nonce = "d8b1f8e5-1111-4222-8333-123456789abc";

  it.each(["2026-W00", "2026-W54", "2026-W1", "unknown"])("rejects invalid week %s", weekKey => {
    expect(parseCancelWeekCustomId(`cancel_week:${weekKey}:${nonce}:confirm`).success).toBe(false);
  });

  it("rejects legacy dialogs without a confirmed week", () => {
    expect(parseCancelWeekCustomId(`cancel_week:${nonce}:confirm`).success).toBe(false);
  });

  it("parses valid confirm id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:2026-W17:${nonce}:confirm`);
    expect(expectParseSuccess(parsed)).toStrictEqual({ kind: "cancel_week", weekKey: "2026-W17", nonce, choice: "confirm" });
  });

  it("parses valid abort id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:2026-W17:${nonce}:abort`);
    expect(expectParseSuccess(parsed)).toStrictEqual({ kind: "cancel_week", weekKey: "2026-W17", nonce, choice: "abort" });
  });

  it("rejects wrong prefix", () => {
    const parsed = parseCancelWeekCustomId(`cancel:2026-W17:${nonce}:confirm`);
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid uuid nonce", () => {
    const parsed = parseCancelWeekCustomId("cancel_week:2026-W17:not-a-uuid:confirm");
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown choice", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:2026-W17:${nonce}:maybe`);
    expect(parsed.success).toBe(false);
  });

  it("rejects wrong segment count", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:2026-W17:${nonce}:confirm:extra`);
    expect(parsed.success).toBe(false);
  });

  it("keeps round-trip identity on valid inputs", () => {
    const raw = `cancel_week:2026-W17:${nonce}:confirm`;
    const parsed = parseCancelWeekCustomId(raw);
    expect(buildCancelWeekCustomId(expectParseSuccess(parsed))).toBe(raw);
  });
});
