import { describe, expect, it, vi } from "vitest";
import { handleInteraction } from "../../src/discord/shared/dispatcher.ts";
import { evaluateAndApplyDeadlineDecision } from "../../src/orchestration/askDeadline.ts";
import { askMessages } from "../../src/features/ask-session/messages.ts";
import { postponeMessages } from "../../src/features/postpone-voting/messages.ts";
import { deferred } from "../helpers/deferred.ts";
import { asInteraction, buildButtonInteraction } from "../helpers/interaction.ts";
import { runEffect } from "../helpers/assertions.ts";
import { createDiscordTextFixture, createEditableMessage } from "../helpers/discord.ts";
import { createTestAppContext } from "../testing/index.ts";
import { createSettleDiscordFixture, seededMembers, sessionRow } from "./settle/harness.ts";

const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
const now = new Date("2026-04-24T12:00:00.000Z");

describe("committed attendance transitions", () => {
  it.each([
    { prefix: "ask_absent", choice: "confirm", status: "ASKING", expected: "POSTPONE_VOTING", wake: "ask_absent_confirmed",
      label: "absence", reply: askMessages.absentConfirm.confirmed, outboxCount: 2 },
    { prefix: "ask_absent", choice: "confirm", status: "ASKING", expected: "POSTPONE_VOTING", wake: "ask_absent_confirmed",
      label: "legacy cancellation", legacy: true, reply: askMessages.absentConfirm.confirmed, outboxCount: 2 },
    { prefix: "postpone_ng", choice: "confirm", status: "POSTPONE_VOTING", expected: "COMPLETED", wake: "postpone_ng_confirmed",
      label: "postpone rejection", reply: postponeMessages.ngConfirm.confirmed, outboxCount: 0 },
    { prefix: "postpone", choice: "ok", status: "POSTPONE_VOTING", expected: "POSTPONED", wake: "postpone_button_recorded",
      label: "postpone acceptance", reply: null, outboxCount: 1 }
  ] as const)("wakes durable work before the $label edit and keeps success if it fails", async testCase => {
    const session = sessionRow({ id: sessionId, status: testCase.status, deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const context = createTestAppContext({ now, seed: {
      sessions: [session], members: seededMembers,
      responses: testCase.prefix === "postpone" ? seededMembers.slice(1).map(member => ({
        id: member.id, sessionId, memberId: member.id, choice: "POSTPONE_OK" as const,
        answeredAt: now, sourceInteractionId: null
      })) : []
    } });
    if ("legacy" in testCase) {
      vi.spyOn(context.ports.sessionCommands, "submitAskResponse").mockImplementationOnce(async () => {
        const cancelled = await context.ports.sessions.cancelAsking({ id: sessionId, now, reason: "absent" });
        if (!cancelled) { throw new Error("Expected a concurrent legacy cancellation"); }
        return { kind: "closed", session: cancelled };
      });
    }
    const fixture = createSettleDiscordFixture();
    const editing = deferred<void>();
    const release = deferred<void>();
    const wakeScheduler = vi.fn();
    fixture.edit.mockImplementation(async () => {
      editing.resolve();
      await release.promise;
      throw new Error("Discord unavailable after commit");
    });
    const interaction = buildButtonInteraction(`${testCase.prefix}:${sessionId}:${testCase.choice}`);
    const handling = handleInteraction(asInteraction(interaction), {
      client: fixture.client, context, wakeScheduler,
      sendAsk: async () => ({ status: "queued", weekKey: "2026-W17" })
    });
    try {
      await editing.promise;
      expect(wakeScheduler).toHaveBeenCalledExactlyOnceWith(testCase.wake);
      expect(await context.ports.sessions.findSessionById(sessionId)).toMatchObject({ status: testCase.expected });
    } finally {
      release.resolve();
      await handling;
    }
    expect(interaction.followUp).not.toHaveBeenCalled();
    const expectedReplies = testCase.reply === null ? [] : [[{ content: testCase.reply, components: [] }]];
    expect(interaction.editReply.mock.calls).toStrictEqual(expectedReplies);
    expect(context.ports.outbox.listEntries()).toHaveLength(testCase.outboxCount);
  });

  it("finishes a short-notice decision even when its public edit fails", async () => {
    const settledAt = new Date("2026-04-24T12:36:00.000Z");
    const session = sessionRow({ id: sessionId });
    const context = createTestAppContext({ now: settledAt, seed: {
      sessions: [session], members: seededMembers,
      responses: seededMembers.map(member => ({ id: member.id, sessionId, memberId: member.id,
        choice: "T2200" as const, answeredAt: now, sourceInteractionId: null }))
    } });
    const fixture = createSettleDiscordFixture();
    fixture.edit.mockRejectedValueOnce(new Error("Discord unavailable after commit"));

    await runEffect(evaluateAndApplyDeadlineDecision(fixture.client, context, session, { now: settledAt, memberCountExpected: 4 }));

    expect(await context.ports.sessions.findSessionById(sessionId)).toMatchObject({ status: "COMPLETED", reminderSentAt: settledAt });
    expect(await context.ports.heldEvents.findBySessionId(sessionId)).toBeDefined();
    expect(context.ports.outbox.listEntries()).toHaveLength(1);
  });

  it("does not let slow Discord editing change the decision-time reminder threshold", async () => {
    const settledAt = new Date("2026-04-24T12:30:00.000Z");
    let clock = settledAt;
    const session = sessionRow({ id: sessionId });
    const context = createTestAppContext({ now: () => clock, seed: {
      sessions: [session], members: seededMembers,
      responses: seededMembers.map(member => ({ id: member.id, sessionId, memberId: member.id,
        choice: "T2200" as const, answeredAt: now, sourceInteractionId: null }))
    } });
    const fixture = createDiscordTextFixture(undefined, {
      fetchedMessage: createEditableMessage("ask-msg-1", async () => { clock = new Date("2026-04-24T12:44:00.000Z"); })
    });

    await runEffect(evaluateAndApplyDeadlineDecision(fixture.client, context, session, { now: settledAt, memberCountExpected: 4 }));

    expect(await context.ports.sessions.findSessionById(sessionId)).toMatchObject({ status: "DECIDED", reminderSentAt: null });
    expect(await context.ports.heldEvents.findBySessionId(sessionId)).toBeUndefined();
  });
});
