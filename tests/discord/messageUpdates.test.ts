import { setImmediate } from "node:timers/promises";
import { type ActionRowBuilder, type ButtonBuilder } from "discord.js";
import { describe, expect, it } from "vitest";

import { updateAskMessage } from "../../src/features/ask-session/messageEditor.ts";
import { refreshPostponeMessage } from "../../src/features/postpone-voting/messageRefresh.ts";
import { deferred } from "../helpers/deferred.ts";
import { createDiscordTextFixture, createEditableMessage } from "../helpers/discord.ts";
import { asButtonInteraction, buildButtonInteraction } from "../helpers/interaction.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { unwrapResultAsync } from "../helpers/assertions.ts";

type Payload = { readonly content: string; readonly components: readonly ActionRowBuilder<ButtonBuilder>[] };
const disabledButtons = (payload: Payload) => payload.components.flatMap(row => row.toJSON().components.map(button => button.disabled));

describe("message updates from persisted state", () => {
  it("serializes edits so an older in-flight render cannot finish after a closed render", async () => {
    const session = buildSessionRow({ askMessageId: "ask-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const entered = deferred<void>(); const release = deferred<void>();
    const written: unknown[] = []; let calls = 0;
    const message = createEditableMessage("ask-id", async payload => {
      calls += 1;
      if (calls === 1) { entered.resolve(); await release.promise; }
      written.push(payload);
    });
    const { client } = createDiscordTextFixture(undefined, { fetchedMessage: message });
    const first = updateAskMessage(client, context, session);
    await entered.promise;
    await context.ports.sessions.skipSession({ id: session.id, cancelReason: "manual_skip" });
    const second = updateAskMessage(client, context, session);
    await setImmediate();
    try { expect(calls).toBe(1); } finally { release.resolve(); await Promise.all([first, second]); }
    const latest = written.at(-1) as Payload;
    expect(latest.content).toContain("お休み");
    expect(disabledButtons(latest)).toStrictEqual([true, true, true, true, true]);
  });

  it("uses the persisted replacement message ID when callers retain an old Session", async () => {
    const session = buildSessionRow({ askMessageId: "deleted-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const fixture = createDiscordTextFixture(async () => ({ id: "replacement-id" }));
    fixture.fetch.mockImplementation(async id => {
      if (id === "deleted-id") { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); }
      return createEditableMessage(id);
    });
    await unwrapResultAsync(updateAskMessage(fixture.client, context, session));
    await unwrapResultAsync(updateAskMessage(fixture.client, context, session));
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.map(call => call[0])).toStrictEqual(["deleted-id", "replacement-id"]);
  });

  it("keeps unrelated sessions responsive while another message edit is waiting", async () => {
    const firstSession = buildSessionRow({ id: "first", askMessageId: "first-message" });
    const secondSession = buildSessionRow({ id: "second", candidateDateIso: "2026-05-01", askMessageId: "second-message" });
    const context = createTestAppContext({ seed: { sessions: [firstSession, secondSession] } });
    const entered = deferred<void>(); const release = deferred<void>();
    const edited: string[] = [];
    const fixture = createDiscordTextFixture();
    fixture.fetch.mockImplementation(async id => createEditableMessage(id, async () => {
      if (id === "first-message") { entered.resolve(); await release.promise; }
      edited.push(id);
    }));
    const first = updateAskMessage(fixture.client, context, firstSession);
    await entered.promise;
    try {
      await unwrapResultAsync(updateAskMessage(fixture.client, context, secondSession));
      expect(edited).toStrictEqual(["second-message"]);
    } finally { release.resolve(); await first; }
    expect(edited).toStrictEqual(["second-message", "first-message"]);
  });

  it("allows a queued closed render to recover after an earlier Discord edit fails", async () => {
    const session = buildSessionRow({ askMessageId: "ask-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const entered = deferred<void>(); const release = deferred<void>();
    const written: unknown[] = []; let attempts = 0;
    const message = createEditableMessage("ask-id", async payload => {
      attempts += 1;
      if (attempts === 1) {
        entered.resolve(); await release.promise;
        throw Object.assign(new Error("Temporary Discord failure"), { code: 50013 });
      }
      written.push(payload);
    });
    const { client } = createDiscordTextFixture(undefined, { fetchedMessage: message });
    const first = updateAskMessage(client, context, session);
    await entered.promise;
    await context.ports.sessions.skipSession({ id: session.id, cancelReason: "manual_skip" });
    const second = updateAskMessage(client, context, session);
    release.resolve();
    expect((await first).isErr()).toBe(true);
    await unwrapResultAsync(second);
    expect(written).toHaveLength(1);
    expect(disabledButtons(written[0] as Payload)).toStrictEqual([true, true, true, true, true]);
  });

  it("keeps a completed postpone vote disabled when a delayed pending response refreshes it", async () => {
    const session = buildSessionRow({ status: "POSTPONED", postponeMessageId: "vote-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const payloads: unknown[] = [];
    const interaction = asButtonInteraction({ ...buildButtonInteraction("postpone:any:ok"),
      message: createEditableMessage("vote-id", async payload => { payloads.push(payload); }) });
    await unwrapResultAsync(refreshPostponeMessage(createDiscordTextFixture().client, context, interaction, session.id));
    const payload = payloads[0] as Payload;
    expect(disabledButtons(payload)).toStrictEqual([true, true]);
    expect(payload.content).toContain("明日の出欠確認へ進みます");
  });
});
