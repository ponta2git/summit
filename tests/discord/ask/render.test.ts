import { beforeEach, describe, expect, it } from "vitest";

import {
  buildAskRow,
  renderAskBody
} from "../../../src/features/ask-session/render.js";
import { buildAskMessageViewModel } from "../../../src/features/ask-session/viewModel.js";
import type { ViewModelResponseInput } from "../../../src/discord/shared/viewModelInputs.js";
import { resetSendStateForTest } from "../../../src/features/ask-session/send.js";
import { appConfig } from "../../../src/userConfig.js";
import { resetShutdownStateForTest } from "../../../src/shutdown.js";
import { memberUserId } from "../../helpers/env.js";
import { buildSessionRow } from "../factories/session.js";

describe("askMessage", () => {
  beforeEach(() => {
    resetSendStateForTest();
    resetShutdownStateForTest();
  });

  it("builds ask buttons with expected custom ids", () => {
    const row = buildAskRow("session-id");
    const buttons = row.toJSON().components.map((component) => ({
      customId: "custom_id" in component ? component.custom_id : undefined,
      label: "label" in component ? component.label : undefined,
      disabled: "disabled" in component ? component.disabled : undefined
    }));

    expect(buttons).toStrictEqual([
      { customId: "ask:session-id:t2200", label: "22:00", disabled: false },
      { customId: "ask:session-id:t2230", label: "22:30", disabled: false },
      { customId: "ask:session-id:t2300", label: "23:00", disabled: false },
      { customId: "ask:session-id:t2330", label: "23:30", disabled: false },
      { customId: "ask:session-id:absent", label: "今回は欠席", disabled: false }
    ]);
  });

  it("renders ask message body with mentions, candidate date, and response state", () => {
    const session = buildSessionRow();
    const members = [
      { id: "m1", userId: memberUserId, displayName: "いーゆー" }
    ];
    const responses: ViewModelResponseInput[] = [
      { memberId: "m1", choice: "T2330" }
    ];

    const vm = buildAskMessageViewModel(session, responses, members);
    const rendered = renderAskBody(vm);

    for (const memberId of appConfig.memberUserIds) {
      expect(rendered.content).toContain(`<@${memberId}>`);
    }
    expect(rendered.content).toContain("開催候補日: 2026-04-24(金) 22:00 以降");
    expect(rendered.content).toContain("- いーゆー : 23:30");
    expect(rendered.content).toContain("23:30");
    expect(rendered.components).toHaveLength(1);
  });

  it("disables ask buttons when session is not ASKING", () => {
    const session = buildSessionRow({ status: "CANCELLED", cancelReason: "absent" });
    const vm = buildAskMessageViewModel(session, [], []);
    const rendered = renderAskBody(vm);
    const first = rendered.components?.[0];
    expect(first).toBeDefined();
    const row = (first as unknown as {
      toJSON: () => { components: { disabled?: boolean }[] };
    }).toJSON();
    expect(row.components.map((component) => component.disabled)).toStrictEqual([
      true,
      true,
      true,
      true,
      true
    ]);
  });
});
