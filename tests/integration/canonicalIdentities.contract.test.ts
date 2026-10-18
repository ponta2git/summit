import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { prepareCanonicalAdapterFixture } from "./_canonicalIdentities.ts";
import { createIntegrationDb, isIntegration, truncatePerTestTables } from "./_support.ts";
import { createAskSession, findSessionById } from "../../src/db/repositories/sessions.ts";
import { submitAskResponse, submitPostponeVote } from "../../src/db/repositories/sessionCommands.ts";
import { cancelWeekAtomically } from "../../src/db/repositories/sessionCommands.cancelWeek.ts";
import { completeDecidedSessionAsHeld, findHeldEventBySessionId } from "../../src/db/repositories/heldEvents.ts";
import { listResponses } from "../../src/db/repositories/responses.ts";
import { findMemberIdByUserId, listMembers } from "../../src/db/repositories/members.ts";
import { loadCurrentWeekSnapshot } from "../../src/db/repositories/status.ts";
import { reconcileMembers } from "../../src/members/reconcile.ts";
import { loadResultCancellationReason } from "../../src/db/repositories/notifications.storage.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { discordNotificationSettings, matchDrafts } from "../../src/db/schema.ts";
import { assertNewNotificationPartLimit } from "../../src/features/result-notifications/render.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";

const checkNotificationAdmission = (payload: Parameters<typeof assertNewNotificationPartLimit>[0]): void =>
  assertNewNotificationPartLimit(payload, "https://example.test");

const storedMember = "11111111-1111-4111-8111-111111111111";
const storedSession = "22222222-2222-4222-8222-222222222222";
const storedResponse = "33333333-3333-4333-8333-333333333333";
const storedHeld = "44444444-4444-4444-8444-444444444444";
const storedDraft = "55555555-5555-4555-8555-555555555555";
const storedAccount = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-04-24T12:00:00Z");
const deadline = new Date("2026-04-24T13:00:00Z");
const start = new Date("2026-04-24T14:00:00Z");
const memberAlias = "member-old-桃";
const sessionAlias = "Friday-session-old";

(isIntegration ? describe : describe.skip)("canonical ID repository boundary", () => {
  const connection = createIntegrationDb({ maxConnections: 4 });
  const { db, client } = connection;
  beforeAll(async () => {
    await prepareCanonicalAdapterFixture(connection);
    await client`INSERT INTO members (id, legacy_id, user_id, display_name)
      VALUES (${storedMember}, ${memberAlias}, '333333333333333333', 'Member')`;
  });
  beforeEach(async () => {
    await truncatePerTestTables(db);
    await client`INSERT INTO sessions (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      VALUES (${storedSession}, ${sessionAlias}, '2026-W17', '2026-04-24', 'ASKING', 'channel', ${deadline.toISOString()})`;
  });

  it("reads exact historical aliases and never treats a stored UUID as a second public alias", async () => {
    expect(await findMemberIdByUserId(db, "333333333333333333")).toBe(memberAlias);
    expect(await listMembers(db)).toEqual([{ id: memberAlias, userId: "333333333333333333", displayName: "Member" }]);
    expect(await findSessionById(db, sessionAlias)).toMatchObject({ id: sessionAlias, status: "ASKING" });
    expect(await findSessionById(db, storedSession)).toBeUndefined();
    expect(await findSessionById(db, sessionAlias.toLowerCase())).toBeUndefined();
  });

  it("keeps the persisted response ID, parent aliases and Discord snowflake ordering", async () => {
    await client`INSERT INTO responses (id, legacy_id, session_id, member_id, choice, source_interaction_id)
      VALUES (${storedResponse}, 'response-old', ${storedSession}, ${storedMember}, 'T2230', 100)`;
    const input = { sessionId: sessionAlias, memberId: memberAlias, responseId: randomUUID(),
      choice: "T2200" as const, sourceInteractionId: "200", now, memberCountExpected: 4 };
    expect(await submitAskResponse(db, input)).toMatchObject({ kind: "accepted_pending",
      response: { id: "response-old", sessionId: sessionAlias, memberId: memberAlias, choice: "T2200" } });
    expect(await submitAskResponse(db, { ...input, responseId: randomUUID(), sourceInteractionId: "150", choice: "ABSENT" }))
      .toMatchObject({ kind: "stale_interaction", response: { id: "response-old", choice: "T2200" } });
    expect(await listResponses(db, sessionAlias)).toMatchObject([{ id: "response-old", sessionId: sessionAlias, memberId: memberAlias }]);
    expect(await loadCurrentWeekSnapshot(db, "2026-W17")).toMatchObject({ sessions: [
      { session: { id: sessionAlias, revision: 1 }, responses: [{ id: "response-old", memberId: memberAlias }] }
    ] });
  });

  it("creates one UUID/alias pair and rejects new non-UUID entities without writing", async () => {
    const input = { id: randomUUID(), weekKey: "2026-W18", postponeCount: 0,
      candidateDateIso: "2026-05-01", channelId: "channel", deadlineAt: deadline };
    expect(await createAskSession(db, input)).toMatchObject({ id: input.id });
    expect(await createAskSession(db, input)).toBeUndefined();
    const [row] = await client`SELECT id::text, legacy_id FROM sessions WHERE legacy_id = ${input.id}`;
    expect(row).toEqual({ id: input.id, legacy_id: input.id });
    await expect(createAskSession(db, { ...input, id: "new-slug", weekKey: "2026-W19" })).rejects.toThrow("standard UUID");
    expect(await findSessionById(db, "new-slug")).toBeUndefined();
  });

  it("keeps legacy attendance links through absence, Saturday creation and week cancellation", async () => {
    const responseId = randomUUID();
    const input = { sessionId: sessionAlias, memberId: memberAlias, responseId,
      choice: "ABSENT" as const, sourceInteractionId: "300", now, memberCountExpected: 1 };
    expect(await submitAskResponse(db, { ...input, memberId: storedMember }))
      .toMatchObject({ kind: "member_not_found" });
    expect(await submitAskResponse(db, input)).toMatchObject({ kind: "transitioned",
      session: { id: sessionAlias, status: "POSTPONE_VOTING" },
      response: { id: responseId, sessionId: sessionAlias, memberId: memberAlias } });
    const saturday = { id: randomUUID(), candidateDateIso: "2026-04-25", deadlineAt: new Date("2026-04-25T13:00:00Z") };
    expect(await submitPostponeVote(db, { ...input, responseId: randomUUID(), sourceInteractionId: "301",
      choice: "POSTPONE_OK", saturday })).toMatchObject({ kind: "transitioned", outcome: "all_ok",
      session: { id: sessionAlias, status: "POSTPONED" }, saturdaySession: { id: saturday.id, status: "ASKING" } });
    const aliases = await client`SELECT DISTINCT session_id FROM discord_notification_attendance ORDER BY session_id`;
    expect(aliases.map(row => row["session_id"]).sort()).toEqual([sessionAlias, saturday.id].sort());
    const result = await cancelWeekAtomically(db, { weekKey: "2026-W17", sentinelSessionId: randomUUID(),
      candidateDateIso: "2026-04-24", channelId: "channel", deadlineAt: deadline, now,
      invokerUserId: "333333333333333333", suppressMentions: true });
    expect(result).toMatchObject({ kind: "applied", skippedSessions: [
      { id: sessionAlias, status: "SKIPPED" }, { id: saturday.id, status: "SKIPPED" }
    ] });
  });

  it("creates and reuses the canonical cancellation sentinel when the week is empty", async () => {
    const id = randomUUID();
    const input = { weekKey: "2026-W19", sentinelSessionId: id, candidateDateIso: "2026-05-08",
      channelId: "channel", deadlineAt: deadline, now, invokerUserId: "333333333333333333", suppressMentions: true };
    expect(await cancelWeekAtomically(db, input)).toMatchObject({ kind: "applied", sentinelCreated: true,
      skippedSessions: [{ id, status: "SKIPPED" }] });
    expect(await cancelWeekAtomically(db, { ...input, sentinelSessionId: randomUUID() }))
      .toMatchObject({ kind: "already_skipped", sentinelCreated: false });
    expect(await findSessionById(db, id)).toMatchObject({ id, status: "SKIPPED" });
  });

  it("reuses a retained HeldEvent and returns historical participant aliases across completion and skip", async () => {
    await client`UPDATE sessions SET status = 'DECIDED', decided_start_at = ${start.toISOString()} WHERE id = ${storedSession}`;
    await client`INSERT INTO held_events (id, legacy_id, session_id, held_date_iso, start_at)
      VALUES (${storedHeld}, 'held-old', ${storedSession}, '2026-04-24', ${start.toISOString()})`;
    const input = { sessionId: sessionAlias, reminderSentAt: now, memberIds: [memberAlias] };
    expect(await completeDecidedSessionAsHeld(db, input)).toMatchObject({
      session: { id: sessionAlias, status: "COMPLETED" }, heldEvent: { id: "held-old", sessionId: sessionAlias },
      participants: [{ heldEventId: "held-old", memberId: memberAlias }]
    });
    expect(await completeDecidedSessionAsHeld(db, input)).toBeUndefined();
    expect(await findHeldEventBySessionId(db, sessionAlias)).toMatchObject({ id: "held-old", sessionId: sessionAlias });
    expect(await cancelWeekAtomically(db, { weekKey: "2026-W17", sentinelSessionId: randomUUID(),
      candidateDateIso: "2026-04-24", channelId: "channel", deadlineAt: deadline, now,
      invokerUserId: "333333333333333333", suppressMentions: true }))
      .toMatchObject({ kind: "already_held", session: { id: sessionAlias } });
  });

  it("rolls back the session and new HeldEvent when a historical member lookup fails", async () => {
    await client`UPDATE sessions SET status = 'DECIDED', decided_start_at = ${start.toISOString()} WHERE id = ${storedSession}`;
    await expect(completeDecidedSessionAsHeld(db, { sessionId: sessionAlias, reminderSentAt: now, memberIds: [storedMember] }))
      .rejects.toMatchObject({ cause: { code: "23502" } });
    expect(await findSessionById(db, sessionAlias)).toMatchObject({ status: "DECIDED", revision: 0 });
    expect(await findHeldEventBySessionId(db, sessionAlias)).toBeUndefined();
    const completed = await completeDecidedSessionAsHeld(db, { sessionId: sessionAlias, reminderSentAt: now, memberIds: [memberAlias] });
    expect(completed?.heldEvent.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(completed?.participants).toMatchObject([{ heldEventId: completed?.heldEvent.id, memberId: memberAlias }]);
  });

  it("preserves aliases during member reconciliation and assigns a stable UUID only to a new member", async () => {
    const inputs = [{ userId: "333333333333333333", displayName: "Renamed", syncDisplayName: true },
      { userId: "777777777777777777", displayName: "New", syncDisplayName: true }];
    await reconcileMembers(inputs, db);
    const first = await listMembers(db);
    await reconcileMembers([...inputs].reverse(), db);
    expect(await listMembers(db)).toEqual(first);
    expect(first.find(row => row.userId === inputs[0]?.userId)).toEqual({ id: memberAlias, userId: inputs[0]?.userId, displayName: "Renamed" });
    const created = first.find(row => row.userId === inputs[1]?.userId);
    expect(created?.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("joins unchanged result notification targets to canonical source rows through their aliases", async () => {
    await client`INSERT INTO momo_login_accounts (id, legacy_id, discord_user_id, display_name)
      VALUES (${storedAccount}, 'result-account', 'result-user', 'Test account') ON CONFLICT DO NOTHING`;
    await client`INSERT INTO match_drafts (id, legacy_id, created_by_account_id, status)
      VALUES (${storedDraft}, 'draft-1', ${storedAccount}, 'draft_ready') ON CONFLICT DO NOTHING`;
    await db.update(discordNotificationSettings).set({ enabled: true, generation: 0n });
    const payload = ocrReceiptPayload();
    const port = makeResultNotificationsPort(db, checkNotificationAdmission);
    expect(await port.receive(JSON.stringify(payload), notificationNow)).toMatchObject({ disposition: "accepted", status: "PENDING" });
    expect(await loadResultCancellationReason(db, payload.notificationId)).toBeNull();
    await db.update(matchDrafts).set({ status: "cancelled" }).where(eq(matchDrafts.id, storedDraft));
    expect(await loadResultCancellationReason(db, payload.notificationId)).toBe("draft_unavailable");
  });
});
