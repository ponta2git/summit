// why: DB 行型と UI ビルダーを decouple する契約。真に cross-feature。
import type { ResponseChoice, SessionStatus } from "../../db/rows.js";

export interface ViewModelMemberInput {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface ViewModelResponseInput {
  readonly memberId: string;
  readonly choice: ResponseChoice;
}

export interface ViewModelSessionInput {
  readonly id: string;
  readonly candidateDateIso: string;
  readonly status: SessionStatus;
  readonly decidedStartAt: Date | null;
}
