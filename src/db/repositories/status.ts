// source-of-truth: `/status` の current-week read model。write なし。

import { and, eq, inArray } from "drizzle-orm";

import type {
  CurrentWeekStatusSnapshot,
  HeldEventRow,
  ResponseRow,
  SessionRow
} from "../ports.ts";
import type { DbLike } from "../rows.ts";
import { heldEvents, responses, sessions } from "../schema.ts";
import { mapResponse } from "./responses.ts";
import { mapSession } from "./sessions.internal.ts";

const STATUS_VISIBLE_STATUSES = [
  "ASKING",
  "POSTPONE_VOTING",
  "DECIDED",
  "CANCELLED"
] as const;

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
 * Load the session data shown by `/status` in one session query and two batched detail queries.
 *
 * @remarks
 * invariant: `POSTPONED` is terminal and is intentionally absent from the main status list.
 * `CANCELLED` is returned separately as a current-week stranded warning. Message recovery has
 * its own broader candidate query because it must still see POSTPONED rows.
 */
export const loadCurrentWeekSnapshot = async (
  db: DbLike,
  weekKey: string
): Promise<CurrentWeekStatusSnapshot> => {
  const visibleRows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.weekKey, weekKey),
        inArray(sessions.status, [...STATUS_VISIBLE_STATUSES])
      )
    );
  const visibleSessions = visibleRows.map(mapSession);
  const detailSessions = visibleSessions.filter((session) =>
    (STATUS_DETAIL_STATUSES as readonly string[]).includes(session.status)
  );
  const detailSessionIds = detailSessions.map((session) => session.id);
  const decidedSessionIds = detailSessions
    .filter((session) => session.status === "DECIDED")
    .map((session) => session.id);

  const [responseResult, heldEventResult] = await Promise.allSettled([
    detailSessionIds.length === 0
      ? Promise.resolve([] as ResponseRow[])
      : db
        .select()
        .from(responses)
        .where(inArray(responses.sessionId, detailSessionIds))
        .then((rows) => rows.map(mapResponse)),
    decidedSessionIds.length === 0
      ? Promise.resolve([] as HeldEventRow[])
      : db
        .select()
        .from(heldEvents)
        .where(inArray(heldEvents.sessionId, decidedSessionIds))
  ]);
  // Ownership of the snapshot read includes both queries, including the failure path.
  if (responseResult.status === "rejected") { throw responseResult.reason; }
  if (heldEventResult.status === "rejected") { throw heldEventResult.reason; }

  const responsesBySessionId = mapRowsBySessionId(responseResult.value);
  const heldEventsBySessionId = mapHeldEventsBySessionId(heldEventResult.value);

  return {
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
