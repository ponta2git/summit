import { describe, expect, it } from "vitest";

import {
  buildCancelWeekCustomId,
  buildCustomId,
  parseCancelWeekCustomId,
  parseCustomId
} from "../../src/discord/shared/customId.js";

describe("customId codec", () => {
  const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";

  it("parses valid ask custom id", () => {
    const parsed = parseCustomId(`ask:${sessionId}:t2230`);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toEqual({
      kind: "ask",
      sessionId,
      choice: "t2230"
    });
  });

  it("parses valid postpone custom id", () => {
    const parsed = parseCustomId(`postpone:${sessionId}:ok`);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toEqual({
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

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(buildCustomId(parsed.data)).toBe(raw);
  });
});

describe("cancel_week customId codec", () => {
  const nonce = "d8b1f8e5-1111-4222-8333-123456789abc";

  it("parses valid confirm id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:confirm`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toEqual({ kind: "cancel_week", nonce, choice: "confirm" });
  });

  it("parses valid abort id", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:abort`);
    expect(parsed.success).toBe(true);
  });

  it("rejects wrong prefix", () => {
    const parsed = parseCancelWeekCustomId(`cancel:${nonce}:confirm`);
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid uuid nonce", () => {
    const parsed = parseCancelWeekCustomId("cancel_week:not-a-uuid:confirm");
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown choice", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:maybe`);
    expect(parsed.success).toBe(false);
  });

  it("rejects wrong segment count", () => {
    const parsed = parseCancelWeekCustomId(`cancel_week:${nonce}:confirm:extra`);
    expect(parsed.success).toBe(false);
  });

  it("keeps round-trip identity on valid inputs", () => {
    const raw = `cancel_week:${nonce}:confirm`;
    const parsed = parseCancelWeekCustomId(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(buildCancelWeekCustomId(parsed.data)).toBe(raw);
  });
});
