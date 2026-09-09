import type {
  AnalysisCompletedNotification,
  AnalysisIdentity,
  Four,
  OcrCompletedNotification,
  RankComparison
} from "@momo/db/notifications";

export const ocrNotification = (): OcrCompletedNotification => ({
  notificationId: "result:ocr_completed:ocr-job-1",
  kind: "ocr_completed",
  schemaVersion: 1,
  sourceJobId: "ocr-job-1",
  occurredAt: "2026-09-09T12:00:00.000Z",
  settingsGeneration: "9007199254740993",
  data: {
    matchDraftId: "draft-1",
    ocrDraftId: "ocr-draft-1",
    imageId: "image-1",
    screenType: "total_assets",
    outcome: "needs_review",
    summary: "読み取りが完了しました。内容を確認してください。",
    context: { gameTitleName: "テスト作品", heldDateIso: "2026-09-08", matchNoInEvent: 2 }
  }
});

const analysisIdentity = (jobId: string): AnalysisIdentity => ({
  jobId,
  inputRevision: "9007199254740993",
  algorithmVersion: "test-v4",
  artifactSchemaVersion: 4,
  validationContractId: null
});

export const rankComparisons = (): Four<RankComparison> => [
  { memberId: "m1", displayName: "葵", before: { matchCount: 4, averageRank: 2.5 }, after: { matchCount: 5, averageRank: 2.2 }, delta: -0.3, comparison: "comparable" },
  { memberId: "m2", displayName: "楓", before: { matchCount: 4, averageRank: 2.5 }, after: { matchCount: 5, averageRank: 2.6 }, delta: 0.1, comparison: "comparable" },
  { memberId: "m3", displayName: "凪", before: { matchCount: 4, averageRank: 2.5 }, after: { matchCount: 5, averageRank: 2.5 }, delta: 0, comparison: "comparable" },
  { memberId: "m4", displayName: "蓮", before: { matchCount: 4, averageRank: 2.5 }, after: { matchCount: 5, averageRank: 2.5001 }, delta: 0.0001, comparison: "comparable" }
];

export const analysisNotification = (): AnalysisCompletedNotification => ({
  notificationId: "result:analysis_completed:analysis-job-1",
  kind: "analysis_completed",
  schemaVersion: 1,
  sourceJobId: "analysis-job-1",
  occurredAt: "2026-09-09T12:00:00.000Z",
  settingsGeneration: "0",
  data: {
    gameTitleId: "title-1",
    gameTitleName: "テスト作品",
    disposition: "published",
    previousAnalysis: analysisIdentity("previous-job"),
    currentAnalysis: analysisIdentity("analysis-job-1"),
    overall: rankComparisons(),
    seasons: [{ seasonId: "season-1", seasonName: "2026年度", ranks: rankComparisons() }],
    matches: [{
      matchId: "match-1",
      sourceRevision: "2",
      heldEventId: "held-1",
      heldDateIso: "2026-09-08",
      matchNoInEvent: 2,
      playedAt: "2026-09-08T15:30:00.000Z",
      mapName: "東日本",
      seasonId: "season-1",
      seasonName: "2026年度",
      ownerName: "葵",
      players: [
        { memberId: "m1", displayName: "葵", rank: 1, ginjiCount: 0 },
        { memberId: "m2", displayName: "楓", rank: 2, ginjiCount: 2 },
        { memberId: "m3", displayName: "凪", rank: 3, ginjiCount: 1 },
        { memberId: "m4", displayName: "蓮", rank: 4, ginjiCount: 0 }
      ],
      ginjiTotal: 3,
      note: "最終年に逆転。\n楽しい試合でした。"
    }]
  }
});
