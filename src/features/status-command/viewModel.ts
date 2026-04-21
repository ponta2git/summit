// invariant: viewModel は pure (I/O なし)。
// why: DB 型を表示層から分離し、テストで容易に検証できるようにする。

import { format } from "date-fns";
import type { HeldEventRow, ResponseRow, SessionRow } from "../../db/ports.js";
import {
  isoWeekKey,
  postponeDeadlineFor,
  parseCandidateDateIso
} from "../../time/index.js";
import { MEMBER_COUNT_EXPECTED } from "../../config.js";
import { collectInvariantWarnings, type InvariantWarning } from "./invariantChecks.js";

// jst: TZ=Asia/Tokyo 前提。date-fns format は内部で getHours() 等を使うため TZ 設定が反映される。
const fmtJst = (d: Date): string => format(d, "MM-dd HH:mm");
const fmtJstFull = (d: Date): string => format(d, "yyyy-MM-dd HH:mm");

export interface SessionStatusViewModel {
  readonly sessionId: string;
  readonly weekKey: string;
  readonly postponeCount: number;
  readonly status: string;
  readonly candidateDateIso: string;
  readonly deadlineAt: string;
  readonly postponeDeadlineAt: string;
  readonly decidedStartAt: string | null;
  readonly reminderAt: string | null;
  readonly reminderSentAt: string | null;
  readonly responseCount: number;
  readonly memberCountExpected: number;
  /** DECIDED sessions: whether HeldEvent exists */
  readonly heldEventExists: boolean | null;
  readonly warnings: readonly InvariantWarning[];
}

export interface StatusViewModel {
  readonly nowJst: string;
  readonly currentWeekKey: string;
  readonly sessions: readonly SessionStatusViewModel[];
  /** ISO string of next upcoming deadline or reminder across all sessions, or null */
  readonly nextEventAt: string | null;
  readonly totalWarnings: number;
}

const buildSessionStatusViewModel = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  heldEvent: HeldEventRow | undefined,
  now: Date
): SessionStatusViewModel => {
  const candidateDate = parseCandidateDateIso(session.candidateDateIso);
  const warnings = collectInvariantWarnings(session, now, heldEvent);

  return {
    sessionId: session.id.slice(0, 8),
    weekKey: session.weekKey,
    postponeCount: session.postponeCount,
    status: session.status,
    candidateDateIso: session.candidateDateIso,
    deadlineAt: fmtJst(session.deadlineAt),
    postponeDeadlineAt: fmtJst(postponeDeadlineFor(candidateDate)),
    decidedStartAt: session.decidedStartAt ? fmtJst(session.decidedStartAt) : null,
    reminderAt: session.reminderAt ? fmtJst(session.reminderAt) : null,
    reminderSentAt: session.reminderSentAt ? fmtJst(session.reminderSentAt) : null,
    responseCount: responses.length,
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    heldEventExists: session.status === "DECIDED" ? heldEvent !== undefined : null,
    warnings
  };
};

/**
 * Computes the earliest upcoming deadline or reminder across all non-terminal sessions.
 */
const buildNextEventAt = (
  sessions: readonly SessionRow[],
  now: Date
): string | null => {
  const candidates: Date[] = [];

  for (const session of sessions) {
    if (session.deadlineAt > now) {
      candidates.push(session.deadlineAt);
    }
    if (session.reminderAt && session.reminderAt > now && session.reminderSentAt === null) {
      candidates.push(session.reminderAt);
    }
  }

  if (candidates.length === 0) { return null; }

  const earliest = candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
  return fmtJstFull(earliest);
};

/**
 * Builds the pure view model for the /status reply.
 *
 * @remarks
 * All inputs are already fetched from ports; this function has no I/O.
 */
export const buildStatusViewModel = (input: {
  readonly now: Date;
  readonly sessions: readonly SessionRow[];
  readonly responsesBySessionId: ReadonlyMap<string, readonly ResponseRow[]>;
  readonly heldEventBySessionId: ReadonlyMap<string, HeldEventRow>;
}): StatusViewModel => {
  const { now, sessions, responsesBySessionId, heldEventBySessionId } = input;

  const sessionVMs = sessions.map((session) => {
    const responses = responsesBySessionId.get(session.id) ?? [];
    const heldEvent = heldEventBySessionId.get(session.id);
    return buildSessionStatusViewModel(session, responses, heldEvent, now);
  });

  const nextEventAt = buildNextEventAt(sessions, now);
  const totalWarnings = sessionVMs.reduce((sum, s) => sum + s.warnings.length, 0);

  return {
    nowJst: fmtJstFull(now),
    currentWeekKey: isoWeekKey(now),
    sessions: sessionVMs,
    nextEventAt,
    totalWarnings
  };
};

/**
 * Renders the status view model as a compact text block for Discord reply.
 *
 * @remarks
 * Discord code block で囲むことで等幅表示にする。
 */
export const renderStatusText = (vm: StatusViewModel): string => {
  const lines: string[] = [];

  lines.push(`現在時刻: ${vm.nowJst} JST  weekKey: ${vm.currentWeekKey}`);

  if (vm.sessions.length === 0) {
    lines.push("非終端セッション: なし");
  } else {
    for (const s of vm.sessions) {
      lines.push("");
      lines.push(`[${s.status}] ${s.sessionId}  week: ${s.weekKey}  postpone: ${s.postponeCount}`);
      lines.push(`  候補日: ${s.candidateDateIso}  締切: ${s.deadlineAt}  順延期限: ${s.postponeDeadlineAt}`);
      if (s.decidedStartAt) {
        lines.push(`  開始確定: ${s.decidedStartAt}`);
      }
      if (s.reminderAt) {
        const sentMark = s.reminderSentAt ? `（送信済 ${s.reminderSentAt}）` : "（未送信）";
        lines.push(`  リマインド予定: ${s.reminderAt} ${sentMark}`);
      }
      if (s.status === "DECIDED") {
        lines.push(`  HeldEvent: ${s.heldEventExists ? "あり" : "なし"}`);
      }
      lines.push(`  回答: ${s.responseCount}/${s.memberCountExpected}`);
      for (const w of s.warnings) {
        lines.push(`  ⚠ ${w.message}`);
      }
    }
  }

  lines.push("");
  lines.push(`次のイベント予定: ${vm.nextEventAt ?? "なし"}`);
  if (vm.totalWarnings > 0) {
    lines.push(`⚠ 合計 ${vm.totalWarnings} 件の invariant 警告`);
  }

  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
};
