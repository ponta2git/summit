// source-of-truth: `/status` の全週 Session / 当週自動募集 read model。write なし。

import { eq, inArray } from "drizzle-orm";
import { ACTIVE_SESSION_STATUSES } from "../../domain/sessionCreation.ts";

import type {
  CurrentWeekStatusSnapshot,
  HeldEventRow,
  ResponseRow,
  SessionRow
} from "../ports.ts";
import type { DbLike } from "../rows.ts";
import { heldEvents, responses, sessions, weeklyAskSchedules } from "../schema.ts";
import { mapResponse } from "./responses.ts";
import { mapSession } from "./sessions.internal.ts";
import { identityLayout, nativeIds } from "../identities.ts";
import { heldEventColumns, responseColumns, sessionColumns } from "../identityColumns.ts";

const STATUS_DETAIL_STATUSES = [
  "ASKING",
  "POSTPONE_VOTING",
  "DECIDED"
] as const;

const mapRowsBySessionId = <T extends { readonly sessionId: string }>(
  rows: readonly T[]
): ReadonlyMap<string, readonly T[]> => {
  const bySessionId = new Map<string, T[]>();
  for (const row of rows) {
    const current = bySessionId.get(row.sessionId);
    if (current) {
      current.push(row);
    } else {
      bySessionId.set(row.sessionId, [row]);
    }
  }
  return bySessionId;
};

const mapHeldEventsBySessionId = (
  rows: readonly HeldEventRow[]
): ReadonlyMap<string, HeldEventRow> =>
  new Map(rows.flatMap((row) =>
    row.sessionId === null ? [] : [[row.sessionId, row] as const]
  ));

/**
 * Load active Sessions across weeks and the selected week's automatic recruitment state.
 *
 * @remarks
 * invariant: `POSTPONED` is terminal and is intentionally absent from the main status list.
 * `CANCELLED` is returned separately as a stranded warning. Message recovery has
 * its own broader candidate query because it must still see POSTPONED rows.
 */
export const loadCurrentWeekSnapshot = async (
  db: DbLike,
  weekKey: string
): Promise<CurrentWeekStatusSnapshot> => {
  const layout = await identityLayout(db);
  const visibleRows = await db
    .select(sessionColumns(layout))
    .from(sessions)
    .where(inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]))
    .orderBy(sessions.candidateDateIso, sessions.id);
  const visibleSessions = visibleRows.map(mapSession);
  const detailSessions = visibleSessions.filter((session) =>
    (STATUS_DETAIL_STATUSES as readonly string[]).includes(session.status)
  );
  const detailSessionIds = detailSessions.map((session) => session.id);
  const decidedSessionIds = detailSessions
    .filter((session) => session.status === "DECIDED")
    .map((session) => session.id);

  const [responseResult, heldEventResult, weeklyResult] = await Promise.allSettled([
    detailSessionIds.length === 0
      ? Promise.resolve([] as ResponseRow[])
      : db
        .select(responseColumns(layout))
        .from(responses)
        .where(inArray(responses.sessionId, nativeIds(layout, sessions, detailSessionIds)))
        .then((rows) => rows.map(mapResponse)),
    decidedSessionIds.length === 0
      ? Promise.resolve([] as HeldEventRow[])
      : db
        .select(heldEventColumns(layout))
        .from(heldEvents)
        .where(inArray(heldEvents.sessionId, nativeIds(layout, sessions, decidedSessionIds))),
    db.select({ disabledAt: weeklyAskSchedules.disabledAt, autoSessionId: weeklyAskSchedules.autoSessionId })
      .from(weeklyAskSchedules).where(eq(weeklyAskSchedules.weekKey, weekKey))
  ]);
  // Ownership of the snapshot read includes every query, including the failure path.
  if (responseResult.status === "rejected") { throw responseResult.reason; }
  if (heldEventResult.status === "rejected") { throw heldEventResult.reason; }
  if (weeklyResult.status === "rejected") { throw weeklyResult.reason; }

  const responsesBySessionId = mapRowsBySessionId(responseResult.value);
  const heldEventsBySessionId = mapHeldEventsBySessionId(heldEventResult.value);
  const weekly = weeklyResult.value[0];

  return {
    weeklyAuto: weekly?.disabledAt ? "disabled" : weekly?.autoSessionId ? "created" : "pending",
    sessions: detailSessions.map((session): {
      readonly session: SessionRow;
      readonly responses: readonly ResponseRow[];
      readonly heldEvent: HeldEventRow | undefined;
    } => ({
      session,
      responses: responsesBySessionId.get(session.id) ?? [],
      heldEvent: heldEventsBySessionId.get(session.id)
    })),
    strandedCancelled: visibleSessions.filter((session) => session.status === "CANCELLED")
  };
};
