import { format } from "date-fns/format";
import type { CurrentWeekStatusSnapshot, HeldEventRow, OutboxDiagnostic, ResponseRow, SessionRow } from "../../db/ports.ts";
import type { SessionStatus } from "../../db/rows.ts";
import {
  isoWeekKey,
  postponeDeadlineFor,
  parseCandidateDateIso
} from "../../time/index.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import {
  checkStrandedCancelledSessions,
  checkStrandedOutboxEntries,
  collectInvariantWarnings,
  type InvariantWarning
} from "./invariantChecks.ts";

// jst: TZ=Asia/Tokyo 前提。date-fns format は getHours() 等を使うため TZ が反映される。
const fmtJst = (instant: Date): string => format(instant, "MM-dd HH:mm");
const fmtJstFull = (instant: Date): string => format(instant, "yyyy-MM-dd HH:mm");

interface StrandedCancelledEntry {
  readonly sessionId: string;
  readonly weekKey: string;
  readonly candidateDateIso: string;
}

interface SessionStatusViewModel {
  readonly sessionId: string;
  readonly weekKey: string;
  readonly postponeCount: number;
  readonly status: SessionStatus;
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

interface StatusViewModel {
  readonly nowJst: string;
  readonly currentWeekKey: string;
  readonly weeklyAuto: CurrentWeekStatusSnapshot["weeklyAuto"];
  readonly sessions: readonly SessionStatusViewModel[];
  readonly nextEventAt: string | null;
  readonly totalWarnings: number;
  readonly strandedCancelled: readonly StrandedCancelledEntry[];
  readonly strandedCancelledWarning: InvariantWarning | null;
  readonly strandedOutboxCount: number;
  readonly strandedOutboxWarning: InvariantWarning | null;
}

const statusCodeBlock = (lines: readonly string[]): string => `\`\`\`\n${lines.join("\n")}\n\`\`\``;

const boundedStatusText = (lines: readonly string[], footer: readonly string[]): string => {
  const lineSize = (total: number, line: string): number => total + line.length + 1;
  const completeLength = 8 + lines.reduce(lineSize, 0) + footer.reduce(lineSize, 0);
  if (completeLength <= 2_000) { return statusCodeBlock([...lines, "", ...footer]); }
  const omission = (count: number): readonly string[] => ["", `… 表示上限のため診断 ${count} 行を省略`, "", ...footer];
  // why: 次回予定と警告合計は障害時にも残し、詳細は行単位で削るためUnicodeを切断しない。
  const budget = 2_000 - statusCodeBlock(omission(lines.length)).length;
  const visible: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > budget) { break; }
    visible.push(line);
    size += line.length + 1;
  }
  return statusCodeBlock([...visible, ...omission(lines.length - visible.length)]);
};

const buildSessionStatusViewModel = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  heldEvent: HeldEventRow | undefined,
  now: Date
): SessionStatusViewModel => {
  const candidateDate = parseCandidateDateIso(session.candidateDateIso);
  const warnings = collectInvariantWarnings(session, now);

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

  const earliest = candidates.reduce((earliestDate, candidate) => (earliestDate.getTime() < candidate.getTime() ? earliestDate : candidate));
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
  readonly weeklyAuto: CurrentWeekStatusSnapshot["weeklyAuto"];
  readonly sessions: readonly SessionRow[];
  readonly responsesBySessionId: ReadonlyMap<string, readonly ResponseRow[]>;
  readonly heldEventBySessionId: ReadonlyMap<string, HeldEventRow>;
  readonly strandedCancelledSessions?: readonly SessionRow[];
  readonly strandedOutboxEntries?: readonly OutboxDiagnostic[];
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
  const perSessionWarnings = sessionVMs.reduce((sum, session) => sum + session.warnings.length, 0);
  const totalWarnings =
    perSessionWarnings +
    (strandedCancelledWarning !== null ? 1 : 0) +
    (strandedOutboxWarning !== null ? 1 : 0);

  const strandedCancelled: StrandedCancelledEntry[] = strandedCancelledSessions.map((session) => ({
    sessionId: session.id.slice(0, 8),
    weekKey: session.weekKey,
    candidateDateIso: session.candidateDateIso
  }));

  return {
    nowJst: fmtJstFull(now),
    currentWeekKey: isoWeekKey(now),
    weeklyAuto: input.weeklyAuto,
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
  const weeklyAutoLabels = { pending: "未作成", disabled: "停止（手動募集は利用可）", created: "生成済み" } as const;
  lines.push(`今週の金曜自動募集: ${weeklyAutoLabels[vm.weeklyAuto]}`);

  if (vm.sessions.length === 0) {
    lines.push("非終端セッション: なし");
  } else {
    for (const session of vm.sessions) {
      lines.push("");
      lines.push(`[${session.status}] ${session.sessionId}  week: ${session.weekKey}  postpone: ${session.postponeCount}`);
      lines.push(`  候補日: ${session.candidateDateIso}  締切: ${session.deadlineAt}  順延期限: ${session.postponeDeadlineAt}`);
      if (session.decidedStartAt) {
        lines.push(`  開始確定: ${session.decidedStartAt}`);
      }
      if (session.reminderAt) {
        const sentMark = session.reminderSentAt ? `（送信済 ${session.reminderSentAt}）` : "（未送信）";
        lines.push(`  リマインド予定: ${session.reminderAt} ${sentMark}`);
      }
      if (session.status === "DECIDED") {
        lines.push(`  HeldEvent: ${session.heldEventExists ? "あり" : "なし"}`);
      }
      lines.push(`  回答: ${session.responseCount}/${session.memberCountExpected}`);
      for (const warning of session.warnings) {
        lines.push(`  ⚠ ${warning.message}`);
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

  const footer = [`次のイベント予定: ${vm.nextEventAt ?? "なし"}`];
  if (vm.totalWarnings > 0) {
    footer.push(`⚠ 合計 ${vm.totalWarnings} 件の invariant 警告`);
  }

  return boundedStatusText(lines, footer);
};
