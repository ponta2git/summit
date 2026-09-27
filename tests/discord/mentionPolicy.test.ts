import { describe, expect, it, vi } from "vitest";
import { renderAskBody } from "../../src/features/ask-session/render.ts";
import { renderPostponeBody } from "../../src/features/postpone-voting/render.ts";
import { renderDecidedAnnouncement } from "../../src/features/decided-announcement/render.ts";
import { updatePostponeMessage } from "../../src/features/postpone-voting/messageEditor.ts";
import { appConfig } from "../../src/userConfig.ts";
import { callArg, runEffect } from "../helpers/assertions.ts";
import { createDiscordTextFixture, createEditableMessage } from "../helpers/discord.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";

const memberUserIds = ["123456789012345678", "223456789012345678"];
const maliciousLabel = "@everyone @here <@&323456789012345678> <@423456789012345678>";

describe("attendance mention policy", () => {
  it.each([false, true])("bounds every label-bearing payload with suppressMentions=%s", suppressMentions => {
    const payloads = [
      renderAskBody({
        sessionId: "session-id", candidateDateIso: "2026-04-24", disabled: false,
        memberUserIds, suppressMentions, responsesByUserId: new Map(),
        displayNameByUserId: new Map([[memberUserIds[0]!, maliciousLabel]]), footer: undefined
      }),
      renderPostponeBody({
        sessionId: "session-id", candidateDateIso: "2026-04-24", disabled: false,
        memberUserIds, suppressMentions,
        memberStatuses: [{ userId: memberUserIds[0]!, displayLabel: maliciousLabel, state: "unanswered" }]
      }),
      renderDecidedAnnouncement({
        startTimeLabel: "22:00", memberUserIds, suppressMentions,
        memberLines: [{ displayName: maliciousLabel, slotLabel: "22:00" }]
      })
    ];
    for (const payload of payloads) {
      expect(payload.content).toContain(maliciousLabel);
      expect(payload.allowedMentions).toStrictEqual({
        parse: [], users: suppressMentions ? [] : memberUserIds, roles: [], repliedUser: false
      });
    }
  });

  it("keeps the explicit mention policy when converting a postpone render to an edit", async () => {
    const session = buildSessionRow({ status: "POSTPONE_VOTING", postponeMessageId: "vote-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const message = createEditableMessage("vote-id");
    const fixture = createDiscordTextFixture(undefined, { fetchedMessage: message });
    await runEffect(updatePostponeMessage(fixture.client, context, session));
    expect(callArg<{ readonly allowedMentions: unknown }>(vi.mocked(message.edit)).allowedMentions).toStrictEqual({
      parse: [], users: appConfig.memberUserIds, roles: [], repliedUser: false
    });
  });
});
