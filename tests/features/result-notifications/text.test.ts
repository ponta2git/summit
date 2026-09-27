import { describe, expect, it } from "vitest";
import { escapeNotificationText, splitNotificationText } from "../../../src/features/result-notifications/text.ts";

describe("notification text boundaries", () => {
  it.each([8_191, 8_192, 16_383])("preserves every escape and Unicode pair across text processing boundaries (%i)", offset => {
    const prefix = "x".repeat(offset);
    const raw = prefix + "😀\\`*_~|<>[]()#界";
    expect(escapeNotificationText(raw)).toBe(prefix + "😀\\\\\\`\\*\\_\\~\\|\\<\\>\\[\\]\\(\\)\\#界");
  });

  it("preserves an almost 8MiB Markdown-dense memo without truncation", () => {
    const count = 8 * 1024 * 1024 - 8_192;
    expect(escapeNotificationText("界" + "*".repeat(count))).toBe("界" + "\\*".repeat(count));
  });

  it.each([
    ["", []],
    ["a".repeat(1_900), ["a".repeat(1_900)]],
    ["head\n" + "a".repeat(3_801), ["head\n", "a".repeat(1_900), "a".repeat(1_900), "a"]],
    ["a".repeat(1_899) + "\nnext", ["a".repeat(1_899) + "\n", "next"]],
    ["a".repeat(1_900) + "\nnext", ["a".repeat(1_900), "\nnext"]],
    ["a".repeat(1_899) + "😀next", ["a".repeat(1_899), "😀next"]],
    ["a".repeat(1_899) + "\\*next", ["a".repeat(1_899), "\\*next"]],
    ["a".repeat(1_898) + "\\\\next", ["a".repeat(1_898) + "\\\\", "next"]]
  ] as const)("keeps version 1 chunks stable (case %#)", (text, expected) => {
    expect(splitNotificationText(text)).toStrictEqual(expected);
  });
});
