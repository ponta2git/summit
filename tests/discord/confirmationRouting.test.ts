import { type ActionRowBuilder, type ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { handleInteraction } from "../../src/discord/shared/dispatcher.ts";
import { callArg } from "../helpers/assertions.ts";
import { createDiscordTextFixture } from "../helpers/discord.ts";
import { asInteraction, buildButtonInteraction, buildCancelInteraction } from "../helpers/interaction.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { createMemberSeededContext, defaultInteractionDeps, successfulSendAsk } from "./interactions.harness.ts";
import { createTestAppContext } from "../testing/index.ts";

type Dialog = { components: readonly ActionRowBuilder<ButtonBuilder>[]; flags?: number };
const buttons = (dialog: Dialog) => dialog.components.flatMap(row => row.toJSON().components.map(button => {
  if (!("custom_id" in button)) { throw new Error("Expected a custom-ID button"); }
  return { customId: button.custom_id, label: button.label, disabled: button.disabled === true, style: button.style };
}));
const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
const now = new Date("2026-04-24T12:00:00Z");

describe("confirmation dialog wiring", () => {
  it("rejects a cancel_week confirmation opened before the ISO week changed", async () => {
    let current = new Date("2026-04-26T14:59:00Z");
    const session = buildSessionRow({ id: sessionId, candidateDateIso: "2026-05-01", weekKey: "2026-W18" });
    const context = createTestAppContext({ now: () => current, seed: { sessions: [session] } });
    const deps = defaultInteractionDeps(successfulSendAsk(), context);
    const prompt = buildCancelInteraction();
    await handleInteraction(asInteraction(prompt), deps);
    const confirmId = buttons(callArg<Dialog>(prompt.editReply))[0]!.customId;
    current = new Date("2026-04-26T15:00:00Z");
    const confirm = buildButtonInteraction(confirmId);
    await handleInteraction(asInteraction(confirm), deps);
    expect(context.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    expect(callArg<{ content: string; components: unknown[] }>(confirm.editReply)).toStrictEqual({
      content: "週が変わったため、この確認は期限切れです。/cancel_week をやり直してください。",
      components: []
    });
  });

  it.each([
    { name: "absence", status: "ASKING", openId: `ask:${sessionId}:absent`, prefix: "ask_absent", label: "今回は欠席で送信する", choice: "ABSENT", final: "POSTPONE_VOTING" },
    { name: "postpone NG", status: "POSTPONE_VOTING", openId: `postpone:${sessionId}:ng`, prefix: "postpone_ng", label: "今週はお流れにする", choice: "POSTPONE_NG", final: "COMPLETED" }
  ] as const)("routes the displayed $name buttons to their corresponding effects", async scenario => {
    const session = buildSessionRow({ id: sessionId, status: scenario.status, askMessageId: "ask-message", postponeMessageId: "vote-message" });
    const context = createMemberSeededContext(session, now);
    const discord = createDiscordTextFixture(async () => ({ id: "posted" }));
    const deps = { ...defaultInteractionDeps(successfulSendAsk(), context), client: discord.client };
    const prompt = buildButtonInteraction(scenario.openId);
    await handleInteraction(asInteraction(prompt), deps);
    const dialog = callArg<Dialog>(prompt.followUp); const rendered = buttons(dialog);
    expect(dialog.flags).toBe(MessageFlags.Ephemeral);
    expect(rendered).toStrictEqual([
      { customId: `${scenario.prefix}:${sessionId}:confirm`, label: scenario.label, disabled: false, style: ButtonStyle.Danger },
      { customId: `${scenario.prefix}:${sessionId}:abort`, label: "キャンセル", disabled: false, style: ButtonStyle.Secondary }
    ]);
    const abort = buildButtonInteraction(rendered[1]!.customId);
    await handleInteraction(asInteraction(abort), deps);
    expect(context.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(context.ports.responses.listAllResponses()).toStrictEqual([]);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    expect(callArg<Dialog>(abort.editReply).components).toStrictEqual([]);
    const confirm = buildButtonInteraction(rendered[0]!.customId);
    await handleInteraction(asInteraction(confirm), deps);
    expect((await context.ports.responses.listResponses(sessionId)).map(row => row.choice)).toStrictEqual([scenario.choice]);
    expect((await context.ports.sessions.findSessionById(sessionId))?.status).toBe(scenario.final);
    expect(callArg<Dialog>(confirm.editReply).components).toStrictEqual([]);
  });

  it("uses one fresh nonce per cancel_week dialog and routes its displayed buttons", async () => {
    const session = buildSessionRow({ id: sessionId }); const context = createMemberSeededContext(session, now);
    const deps = defaultInteractionDeps(successfulSendAsk(), context);
    const prompt = buildCancelInteraction(); await handleInteraction(asInteraction(prompt), deps);
    expect(prompt.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const rendered = buttons(callArg<Dialog>(prompt.editReply));
    const nonce = rendered[0]!.customId.split(":")[2];
    expect(nonce).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(rendered).toStrictEqual([
      { customId: `cancel_week:2026-W17:${nonce}:confirm`, label: "今週はお休みにする", disabled: false, style: ButtonStyle.Danger },
      { customId: `cancel_week:2026-W17:${nonce}:abort`, label: "キャンセル", disabled: false, style: ButtonStyle.Secondary }
    ]);
    const secondPrompt = buildCancelInteraction(); await handleInteraction(asInteraction(secondPrompt), deps);
    expect(buttons(callArg<Dialog>(secondPrompt.editReply))[0]!.customId).not.toBe(rendered[0]!.customId);
    await handleInteraction(asInteraction(buildButtonInteraction(rendered[1]!.customId)), deps);
    expect(context.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    const confirm = buildButtonInteraction(rendered[0]!.customId); await handleInteraction(asInteraction(confirm), deps);
    expect((await context.ports.sessions.findSessionById(sessionId))?.status).toBe("SKIPPED");
    expect(context.ports.outbox.listEntries().map(row => row.dedupeKey)).toStrictEqual(["cancel-week-notice-2026-W17"]);
    expect(callArg<Dialog>(confirm.editReply).components).toStrictEqual([]);
  });
});
