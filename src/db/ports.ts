// source-of-truth: DB 境界を表す port 契約。repository 実装はここを `satisfies` し、
//   テストは Fake 実装でここを満たす。call-site は `ctx.ports.sessions.findSessionById(id)` 形で読める。
// why: db ハンドルを port 実装が closure で保持し、call-site を db 非依存にする。Discord client は
//   抽象化しない（ADR-0017）。この非対称は意図的で、DB は testability の要、Discord は discord.js を直接扱う方がシンプル。
// @see docs/adr/0018-port-wiring-and-factory-injection.md
// @see docs/adr/0026-boundary-rationalization.md

import type {
  MemberRow,
  ResponseRow,
  SessionRow,
  SessionStatus
} from "./rows.js";
import type {
  CreateAskSessionInput,
  TransitionInput
} from "./repositories/sessions.js";
import type { UpsertResponseInput } from "./repositories/responses.js";

export type {
  MemberRow,
  ResponseRow,
  SessionRow,
  SessionStatus,
  CreateAskSessionInput,
  TransitionInput,
  UpsertResponseInput
};
export type { ResponseChoice } from "./rows.js";

/**
 * Session repository operations exposed as a DI port.
 *
 * @remarks
 * 各実装は DB を正本とし、競合時に `undefined` を返す CAS 契約を維持する。
 * @see docs/adr/0001-single-instance-db-as-source-of-truth.md
 */
export interface SessionsPort {
  createAskSession(input: CreateAskSessionInput): Promise<SessionRow | undefined>;
  findSessionByWeekKeyAndPostponeCount(
    weekKey: string,
    postponeCount: number
  ): Promise<SessionRow | undefined>;
  findSessionById(id: string): Promise<SessionRow | undefined>;
  updateAskMessageId(id: string, messageId: string): Promise<void>;
  updatePostponeMessageId(id: string, messageId: string): Promise<void>;
  transitionStatus(input: TransitionInput): Promise<SessionRow | undefined>;
  findDueAskingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDuePostponeVotingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDueReminderSessions(now: Date): Promise<readonly SessionRow[]>;
  findNonTerminalSessions(): Promise<readonly SessionRow[]>;
  findNonTerminalSessionsByWeekKey(weekKey: string): Promise<readonly SessionRow[]>;
  skipSession(input: { id: string; cancelReason: string }): Promise<SessionRow | undefined>;
  isNonTerminal(status: SessionStatus): boolean;
}

export interface ResponsesPort {
  listResponses(sessionId: string): Promise<readonly ResponseRow[]>;
  upsertResponse(input: UpsertResponseInput): Promise<ResponseRow>;
}

export interface MembersPort {
  findMemberIdByUserId(userId: string): Promise<string | undefined>;
  listMembers(): Promise<readonly MemberRow[]>;
}

/**
 * Aggregate port bundle supplied to handlers / scheduler / workflow via AppContext.
 *
 * @remarks
 * Discord client は抽象化しない (ADR-0017 参照)。本 Bot 規模では discord.js の Client / ButtonInteraction
 * を直接扱う方がシンプルで、追加の抽象レイヤは便益を生まない。
 */
export interface AppPorts {
  readonly sessions: SessionsPort;
  readonly responses: ResponsesPort;
  readonly members: MembersPort;
}
