export type SessionStatus =
  | "ASKING"
  | "POSTPONE_VOTING"
  | "POSTPONED"
  | "DECIDED"
  | "CANCELLED"
  | "COMPLETED"
  | "SKIPPED";

export type ResponseChoice =
  | "T2200"
  | "T2230"
  | "T2300"
  | "T2330"
  | "ABSENT"
  | "POSTPONE_OK"
  | "POSTPONE_NG";

export interface SessionRecord {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDateIso: string;
  status: SessionStatus;
  channelId: string;
  askMessageId: string | null;
  postponeMessageId: string | null;
  deadlineAt: Date;
  decidedStartAt: Date | null;
  cancelReason: string | null;
  reminderAt: Date | null;
  reminderSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResponseRecord {
  id: string;
  sessionId: string;
  memberId: string;
  choice: ResponseChoice;
  answeredAt: Date;
}

export interface MemberRecord {
  id: string;
  userId: string;
  displayName: string;
}

export interface CreateAskSessionInput {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDateIso: string;
  channelId: string;
  deadlineAt: Date;
}

export interface TransitionInput {
  id: string;
  from: SessionStatus;
  to: SessionStatus;
  cancelReason?: string;
  decidedStartAt?: Date;
  reminderAt?: Date;
}

export interface UpsertResponseInput {
  id: string;
  sessionId: string;
  memberId: string;
  choice: ResponseChoice;
  answeredAt: Date;
}

// why: port を先に固定し、後続の DI 導入で依存反転を段階的に進める。
// invariant: src/ports は純粋な型定義のみを持ち、runtime 依存を持ち込まない。
/**
 * Session repository operations exposed as a DI port.
 *
 * @remarks
 * 各実装は DB を正本とし、競合時に `undefined` を返す CAS 契約を維持する。
 * @see docs/adr/0015-ports-and-repositories.md
 */
export interface SessionsPort<TDb = unknown, TSession extends SessionRecord = SessionRecord> {
  createAskSession(db: TDb, input: CreateAskSessionInput): Promise<TSession | undefined>;
  findSessionByWeekKeyAndPostponeCount(
    db: TDb,
    weekKey: string,
    postponeCount: number
  ): Promise<TSession | undefined>;
  findSessionById(db: TDb, id: string): Promise<TSession | undefined>;
  updateAskMessageId(db: TDb, id: string, messageId: string): Promise<void>;
  updatePostponeMessageId(db: TDb, id: string, messageId: string): Promise<void>;
  transitionStatus(db: TDb, input: TransitionInput): Promise<TSession | undefined>;
  findDueAskingSessions(db: TDb, now: Date): Promise<ReadonlyArray<TSession>>;
  findNonTerminalSessions(db: TDb): Promise<ReadonlyArray<TSession>>;
  isNonTerminal(status: SessionStatus): boolean;
}

export interface ResponsesPort<TDb = unknown, TResponse extends ResponseRecord = ResponseRecord> {
  listResponses(db: TDb, sessionId: string): Promise<ReadonlyArray<TResponse>>;
  upsertResponse(db: TDb, input: UpsertResponseInput): Promise<TResponse>;
}

export interface MembersPort<TDb = unknown, TMember extends MemberRecord = MemberRecord> {
  findMemberIdByUserId(db: TDb, userId: string): Promise<string | undefined>;
  listMembers(db: TDb): Promise<ReadonlyArray<TMember>>;
}

export interface DiscordPort {
  sendMessage(input: {
    channelId: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<{ messageId: string }>;
  editMessage(input: {
    channelId: string;
    messageId: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  replyEphemeral(input: {
    interactionId: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  deferUpdate(input: { interactionId: string }): Promise<void>;
}
