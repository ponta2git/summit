import type { SessionRow } from "../../src/db/rows.ts";
import { deadlineFor, parseCandidateDateIso, postponeDeadlineFor, isoWeekKey, reminderAtFor } from "../../src/time/index.ts";
import { appConfig } from "../../src/userConfig.ts";
import { makeSession } from "./fixtures.ts";

// why: 通常fixtureは候補日・状態から関連時刻をまとめて組み立てる。
// 不正rowの診断には低水準の makeSession を明示して使う。
export const buildSessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => {
  const candidateDateIso = overrides.candidateDateIso ?? (overrides.postponeCount === 1 ? "2026-04-25" : "2026-04-24");
  const candidate = parseCandidateDateIso(candidateDateIso);
  const status = overrides.status ?? "ASKING";
  const start = status === "DECIDED" ? new Date(`${candidateDateIso}T14:00:00.000Z`) : null;
  return makeSession({
    id: "session-default", channelId: appConfig.discord.channelId,
    candidateDateIso, weekKey: isoWeekKey(candidate), status,
    deadlineAt: status === "POSTPONE_VOTING" || status === "POSTPONED" ? postponeDeadlineFor(candidate) : deadlineFor(candidate),
    decidedStartAt: start, reminderAt: start ? reminderAtFor(start) : null,
    createdAt: new Date(0), updatedAt: new Date(0), ...overrides
  });
};

type Identity = Pick<SessionRow, "id" | "channelId" | "askMessageId" | "postponeMessageId" | "revision">;
export const saturdayAsking = (identity: Partial<Identity> = {}): SessionRow =>
  buildSessionRow({ ...identity, candidateDateIso: "2026-04-25", postponeCount: 1 });
export const fridayPostponeVoting = (identity: Partial<Identity> = {}): SessionRow =>
  buildSessionRow({ ...identity, status: "POSTPONE_VOTING", cancelReason: "absent" });
