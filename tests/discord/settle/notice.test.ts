import { describe, expect, it } from "vitest";

import {
  buildSettleNoticeViewModel,
  renderSettleNotice
} from "../../../src/features/ask-session/viewModel.js";
import { appConfig } from "../../../src/userConfig.js";

describe("buildSettleNoticeViewModel", () => {
  it.each([
    {
      reason: "absent" as const,
      cancelText: "🛑 今回は予定がそろわなかったため、お流れです。"
    },
    {
      reason: "deadline_unanswered" as const,
      cancelText: "🛑 21:30 までに4人分の回答がそろわなかったため、今回はお流れです。"
    },
    {
      reason: "saturday_cancelled" as const,
      cancelText: "🛑 土曜回も予定がそろわなかったため、今週はお流れです。"
    }
  ])("builds the complete $reason notice", ({ reason, cancelText }) => {
    expect(buildSettleNoticeViewModel(reason)).toStrictEqual({
      cancelText,
      memberUserIds: appConfig.memberUserIds,
      suppressMentions: appConfig.dev.suppressMentions
    });
  });

  it("forces mention suppression for the Friday pre-postpone notice", () => {
    expect(buildSettleNoticeViewModel("absent", {
      forceSuppressMentions: true
    })).toStrictEqual({
      cancelText: "🛑 今回は予定がそろわなかったため、お流れです。",
      memberUserIds: appConfig.memberUserIds,
      suppressMentions: true
    });
  });
});

describe("renderSettleNotice", () => {
  it("renders mentions and cancellation text without mutating either", () => {
    expect(renderSettleNotice({
      cancelText: "cancelled",
      memberUserIds: ["u1", "u2"],
      suppressMentions: false
    })).toStrictEqual({ content: "<@u1> <@u2>\ncancelled" });
  });

  it("omits both the mention line and a leading newline when suppressed", () => {
    expect(renderSettleNotice({
      cancelText: "cancelled",
      memberUserIds: ["u1", "u2"],
      suppressMentions: true
    })).toStrictEqual({ content: "cancelled" });
  });
});
