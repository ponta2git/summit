import { format } from "date-fns";
import type { HeldEventRow, OutboxEntry, ResponseRow, SessionRow } from "../../db/ports.js";
import {
  isoWeekKey,
  postponeDeadlineFor,
  parseCandidateDateIso
} from "../../time/index.js";
import { MEMBER_COUNT_EXPECTED } from "../../config.js";
import {
  checkStrandedCancelledSessions,
  checkStrandedOutboxEntries,
  collectInvariantWarnings,
  type InvariantWarning
} from "./invariantChecks.js";

// jst: TZ=Asia/Tokyo 前提。date-fns format は getHours() 等を使うため TZ が反映される @see ADR-0002
const fmtJst = (d: Date): string => format(d, "MM-dd HH:mm");
const fmtJstFull = (d: Date): string => format(d, "yyyy-MM-dd HH:mm");

export interface StrandedCancelledEntry {
  readonly sessionId: string;
  readonly weekKey: string;
  readonly candidateDateIso: string;
}

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
  readonly heldEventExists: boolean | null;
  readonly warnings: readonly InvariantWarning[];
}

export interface StatusViewModel {
  readonly nowJst: string;
  readonly currentWeekKey: string;
  readonly sessions: readonly SessionStatusViewModel[];
  readonly nextEventAt: string | null;
  readonly totalWarnings: number;
  readonly strandedCancelled: readonly StrandedCancelledEntry[];
  readonly strandedCancelledWarning: InvariantWarning | null;
  readonly strandedOutboxCount: number;
  readonly strandedOutboxWarning: InvariantWarning | null;
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
 * Build the pure view model for the /status reply.
 *
 * @remarks
 * Pure. 入力は全て ports から fetch 済み。
 */
export const buildStatusViewModel = (input: {
  readonly now: Date;
  readonly sessions: readonly SessionRow[];
  readonly responsesBySessionId: ReadonlyMap<string, readonly ResponseRow[]>;
  readonly heldEventBySessionId: ReadonlyMap<string, HeldEventRow>;
  readonly strandedCancelledSessions?: readonly SessionRow[];
  readonly strandedOutboxEntries?: readonly OutboxEntry[];
}): StatusViewModel => {
  const { now, sessions, responsesBySessionId, heldEventBySessionId } = input;
  const strandedCancelledSessions = input.strandedCancelledSessions ?? [];
  const strandedOutboxEntries = input.strandedOutboxEntries ?? [];

  const sessionVMs = sessions.map((session) => {
    const responses = responsesBySessionId.get(session.id) ?? [];
    const heldEvent = heldEventBySessionId.get(session.id);
    return buildSessionStatusViewModel(session, responses, heldEvent, now);
  });

  const nextEventAt = buildNextEventAt(sessions, now);
  const strandedCancelledWarning = checkStrandedCancelledSessions(strandedCancelledSessions) ?? null;
  const strandedOutboxWarning = checkStrandedOutboxEntries(strandedOutboxEntries) ?? null;
  const perSessionWarnings = sessionVMs.reduce((sum, s) => sum + s.warnings.length, 0);
  const totalWarnings =
    perSessionWarnings +
    (strandedCancelledWarning !== null ? 1 : 0) +
    (strandedOutboxWarning !== null ? 1 : 0);

  const strandedCancelled: StrandedCancelledEntry[] = strandedCancelledSessions.map((s) => ({
    sessionId: s.id.slice(0, 8),
    weekKey: s.weekKey,
    candidateDateIso: s.candidateDateIso
  }));

  return {
    nowJst: fmtJstFull(now),
    currentWeekKey: isoWeekKey(now),
    sessions: sessionVMs,
    nextEventAt,
    totalWarnings,
    strandedCancelled,
    strandedCancelledWarning,
    strandedOutboxCount: strandedOutboxEntries.length,
    strandedOutboxWarning
  };
};

/**
 * Render the status view model as a Discord code-block text.
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

  if (vm.strandedCancelled.length > 0) {
    lines.push("");
    lines.push(`⚠ 宙づり CANCELLED (reconciler 未達): ${vm.strandedCancelled.length} 件`);
    for (const sc of vm.strandedCancelled) {
      lines.push(`  [CANCELLED] ${sc.sessionId}  week: ${sc.weekKey}  候補日: ${sc.candidateDateIso}`);
    }
  }

  if (vm.strandedOutboxWarning !== null) {
    lines.push("");
    lines.push(`⚠ ${vm.strandedOutboxWarning.message}`);
  }

  lines.push("");
  lines.push(`次のイベント予定: ${vm.nextEventAt ?? "なし"}`);
  if (vm.totalWarnings > 0) {
    lines.push(`⚠ 合計 ${vm.totalWarnings} 件の invariant 警告`);
  }

  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
};
