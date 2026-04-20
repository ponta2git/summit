// why: DB 行型と UI ビルダーを decouple する契約。真に cross-feature。
export interface ViewModelMemberInput {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface ViewModelResponseInput {
  readonly memberId: string;
  readonly choice: string;
}

export interface ViewModelSessionInput {
  readonly id: string;
  readonly candidateDateIso: string;
  readonly status: string;
  readonly decidedStartAt: Date | null;
}
