import { beforeEach, describe, expect, it } from "vitest";

import {
  buildAskRow,
  renderAskBody
} from "../../../src/discord/ask/render.js";
import { __resetSendStateForTest } from "../../../src/discord/ask/send.js";
import type { ResponseRow } from "../../../src/db/repositories/sessions.js";
import { env } from "../../../src/env.js";
import { __resetShutdownStateForTest } from "../../../src/shutdown.js";
import { memberUserId } from "../../helpers/env.js";
import { buildSessionRow } from "../factories/session.js";

describe("askMessage", () => {
  beforeEach(() => {
    __resetSendStateForTest();
    __resetShutdownStateForTest();
  });

  it("builds ask buttons with expected custom ids", () => {
    const row = buildAskRow("session-id");
    const customIds = row
      .toJSON()
      .components.map((component) => ("custom_id" in component ? component.custom_id : undefined));

    expect(customIds).toEqual([
      "ask:session-id:t2200",
      "ask:session-id:t2230",
      "ask:session-id:t2300",
      "ask:session-id:t2330",
      "ask:session-id:absent"
    ]);
  });

  it("renders ask message body with mentions, candidate date, and response state", () => {
    const session = buildSessionRow();
    const memberLookup = new Map([["m1", memberUserId]]);
    const responses: ResponseRow[] = [
      {
        id: "r1",
        sessionId: session.id,
        memberId: "m1",
        choice: "T2330",
        answeredAt: new Date("2026-04-24T20:00:00+09:00")
      }
    ];

    const rendered = renderAskBody(session, responses, memberLookup);

    for (const memberId of env.MEMBER_USER_IDS) {
      expect(rendered.content).toContain(`<@${memberId}>`);
    }
    expect(rendered.content).toContain("開催候補日: 2026-04-24(金) 22:00 以降");
    expect(rendered.content).toContain("23:30");
    expect(rendered.components).toHaveLength(1);
  });

  it("disables ask buttons when session is not ASKING", () => {
    const session = buildSessionRow({ status: "CANCELLED", cancelReason: "absent" });
    const rendered = renderAskBody(session, [], new Map());
    const first = rendered.components?.[0] as unknown as {
      toJSON?: () => { components: { disabled?: boolean }[] };
    };
    const row = first?.toJSON?.();
    const allDisabled = row?.components.every((c) => c.disabled === true);
    expect(allDisabled).toBe(true);
  });
});
