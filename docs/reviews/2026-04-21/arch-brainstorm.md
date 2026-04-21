# Architecture Review Findings (brainstorm) — arch-brainstorm (gpt-5.3-codex)

## 1. 層構造 / 依存方向（features・discord/shared・db・scheduler）
- 観点: src/features/* が業務機能を持ち、src/discord/shared/* は cross-cutting のみか。scheduler/members/time が infra として分離されているか（ADR-0025/26/27/28/29）。
- 評価方法: rg '^import .*from "' src/features src/discord src/scheduler で依存先を抽出し、許可方向（features→shared/time/db ports）をチェック。
- 粒度/単位タスク: 「feature ごとの import 依存表を作る」「shared に feature 固有処理が残っていないか列挙」。
- 期待成果物: 依存方向違反リスト + 層図（テキスト可）。
- 優先度: High（境界崩壊は保守性に直結）。
- 該当 ADR / ファイル例: ADR-0025/0026/0027/0028/0029, src/features/*, src/discord/shared/*

## 2. .github/instructions の applyTo 境界と実装一致
- 観点: time/db/interaction/runtime/comment ルールが対象パスに実際適用可能な構成か（実ファイル配置とのズレ）。
- 評価方法: instruction の対象 glob と glob src/**/*.ts tests/**/*.ts を突合、対象外ホットスポットを抽出。
- 粒度/単位タスク: 「applyTo と実ファイルの対応表を作る」。
- 期待成果物: ルール適用漏れ候補リスト。
- 優先度: Medium（レビュー漏れ防止）。
- 該当 ADR / ファイル例: .github/instructions/*.md, src/**, tests/**

## 3. 依存注入（AppContext/ports）準拠度
- 観点: handler/scheduler/workflow が ctx.ports.* と ctx.clock 経由か。直 repo import 残存有無。
- 評価方法: rg 'db/repositories' src/features src/scheduler src/discord、rg 'ctx\.ports|ctx\.clock' src/features src/scheduler。
- 粒度/単位タスク: 「直 import 検知→一覧化」「ctx 経由化漏れ抽出」。
- 期待成果物: ADR-0018 準拠チェック表。
- 優先度: High（テスト容易性と境界維持の中核）。
- 該当 ADR / ファイル例: ADR-0018, src/appContext.ts, src/db/ports.ts, src/db/ports.real.ts

## 4. テスト側 DI 運用（Fake ports / createTestAppContext）
- 観点: 新規テストが vi.mock(db/repositories) へ逆戻りしていないか。Fake ports で契約を守れているか。
- 評価方法: rg 'vi\.mock\(".*db/repositories' tests、rg 'createTestAppContext' tests。
- 粒度/単位タスク: 「vi.mock 残存の分類（許容/非許容）」。
- 期待成果物: テスト注入方式の準拠レポート。
- 優先度: High（interface drift 防止）。
- 該当 ADR / ファイル例: ADR-0018, tests/testing/ports.ts, tests/scheduler/deadline.test.ts

## 5. 状態遷移モデル（7 状態 × 許可遷移）
- 観点: ASKING/POSTPONE_VOTING/POSTPONED/DECIDED/CANCELLED/COMPLETED/SKIPPED の遷移が仕様と一致し、終端処理が一貫しているか。
- 評価方法: transitionStatus 呼び出しを全列挙し from→to マトリクス化。requirements/base.md §8 と比較。
- 粒度/単位タスク: 「from/to 抽出」「遷移表と仕様差分作成」。
- 期待成果物: 遷移許可表 + 未定義遷移リスト。
- 優先度: High（業務ロジック破綻リスク）。
- 該当 ADR / ファイル例: ADR-0001/0019/0023/0024/0031, src/db/schema.ts, src/db/repositories/sessions.ts

## 6. CAS 一貫性（UPDATE ... WHERE status = ...）
- 観点: 状態更新が CAS 前提で統一され、race lost を undefined 等で扱っているか。
- 評価方法: rg 'transitionStatus\(|claimReminderDispatch|skipSession' src + 実装読解。
- 粒度/単位タスク: 「CAS 利用箇所をカテゴリ分け（state/reminder/manual skip）」。
- 期待成果物: CAS 適用漏れ候補一覧。
- 優先度: High（同時押下/cron 競合対策の要）。
- 該当 ADR / ファイル例: ADR-0001/0003/0024/0023, src/db/repositories/sessions.ts

## 7. DB 正本原則（表示失敗時の扱い）
- 観点: message.edit 失敗時に DB を巻き戻さない・再描画は DB 再取得から、が徹底されているか。
- 評価方法: rg 'message\.edit|followUp|logger\.warn' src/features src/discord で失敗ハンドリングを追跡。
- 粒度/単位タスク: 「編集失敗時の挙動を feature 別に棚卸し」。
- 期待成果物: DB-as-SoT 準拠チェックリスト。
- 優先度: High（復旧性に直結）。
- 該当 ADR / ファイル例: ADR-0001/0004, src/features/ask-session/button.ts, src/features/postpone-voting/button.ts

## 8. スケジューラ設計（登録・tick・起動時回復）
- 観点: cron 登録一元化、noOverlap、起動時 recovery→scheduler 作成順、毎 tick DB 再計算の徹底。
- 評価方法: src/index.ts と src/scheduler/index.ts のフロー図化、tests/scheduler/*.test.ts 対照。
- 粒度/単位タスク: 「起動シーケンス検証」「tick ごとの冪等前提整理」。
- 期待成果物: scheduler レビュー観点表（ask/deadline/postpone/reminder 別）。
- 優先度: High（運用事故に直結）。
- 該当 ADR / ファイル例: ADR-0001/0024, src/index.ts, src/scheduler/index.ts

## 9. 時刻基盤（JST 固定・time 集約・ISO 週）
- 観点: src/time/ 以外で new Date()/Date.parse() の仕様判定がないか。ISO 週年跨ぎを getISOWeekYear + getISOWeek で統一しているか。
- 評価方法: scripts/verify/forbidden-patterns.sh の no-adhoc-date ルール活用 + rg 'new Date\(|Date\.parse\(' src。
- 粒度/単位タスク: 「時刻 API 呼び出し棚卸し」「time 層外時刻計算の検知」。
- 期待成果物: time 集約遵守レポート。
- 優先度: High（締切誤判定防止）。
- 該当 ADR / ファイル例: ADR-0002, src/time/index.ts, tests/time/jst.test.ts

## 10. エラーハンドリング（AppError + neverthrow の適用境界）
- 観点: neverthrow が「境界中心」で使われ、業務エラーは状態表現を維持しているか（全面採用に流れていないか）。
- 評価方法: rg 'from "neverthrow"' src、rg 'throw new Error|toAppError|AppError' src。
- 粒度/単位タスク: 「neverthrow 利用箇所の境界分類（guard/button/errors）」。
- 期待成果物: ADR-0015/0021 との差分表。
- 優先度: Medium-High（設計一貫性）。
- 該当 ADR / ファイル例: ADR-0015/0021, src/errors/*, src/features/*/button.ts

## 11. Interaction 層（ack 順序・cheap-first・reject 一貫性）
- 観点: deferUpdate/deferReply が 3 秒制約内で先行し、guild→channel→member→custom_id→DB 再取得順が守られているか。
- 評価方法: dispatcher.ts + 各 command/button handler を順序チェック。テスト tests/discord/interactions.test.ts 照合。
- 粒度/単位タスク: 「handler ごとの検証順序レビュー票作成」。
- 期待成果物: interaction 順序逸脱候補一覧。
- 優先度: High（UX/失敗率/安全性）。
- 該当 ADR / ファイル例: ADR-0004/0020, src/discord/shared/dispatcher.ts, src/features/*/{button,command}.ts

## 12. Custom ID codec / guard 契約
- 観点: custom_id parse/build が 1 箇所（customId.ts）に集約され、handler 側で生文字列解釈していないか。
- 評価方法: rg 'split\(":")\|startsWith\("ask:\|postpone:"' src で parser bypass 検知、guard 経由率確認。
- 粒度/単位タスク: 「custom_id 処理経路の一意化チェック」。
- 期待成果物: codec 逸脱候補リスト。
- 優先度: Medium-High（不正入力耐性）。
- 該当 ADR / ファイル例: ADR-0016/0030, src/discord/shared/customId.ts, src/discord/shared/guards.ts

## 13. feature module 粒度（render/viewModel/messages/messageEditor/settle）
- 観点: feature 内で UI 資産と業務処理がまとまり、shared に逆流していないか。feature 間 import が pure builder 範囲に収まるか。
- 評価方法: feature 別のファイル責務表作成、rg '^import .*from "\.\./[^"]+"' src/features で横断依存抽出。
- 粒度/単位タスク: 「feature ごとに責務マッピング」「shared 残留の feature 固有物検知」。
- 期待成果物: モジュール責務評価レポート。
- 優先度: Medium（変更容易性）。
- 該当 ADR / ファイル例: ADR-0025/0027/0028, src/features/*, src/discord/shared/*

## 14. env/config 分離と SSoT taxonomy
- 観点: env.ts（検証済み入力）と config.ts（tunable）分担が守られ、値の重複記述（コメント/ADR）drift がないか。
- 評価方法: rg 'process\.env' src（許可例外確認）、rg 'CRON_|ASK_DEADLINE|POSTPONE_DEADLINE' docs src で重複記述確認。
- 粒度/単位タスク: 「値 SSoT 所在マップ更新」「重複リテラル候補抽出」。
- 期待成果物: SSoT drift 監査メモ。
- 優先度: Medium-High（運用変更時の事故予防）。
- 該当 ADR / ファイル例: ADR-0013/0022, src/env.ts, src/config.ts

## 15. DB 運用・migration 安全性
- 観点: generate→migrate→check 運用、DIRECT_URL 限定利用、push 禁止がコード/CI/docs で一致しているか。
- 評価方法: package.json scripts、drizzle.config.ts、scripts/verify/migration-drift.sh、README/PR template を突合。
- 粒度/単位タスク: 「DB 運用チェックリスト作成」「逸脱検知ポイント整理」。
- 期待成果物: migration 運用監査項目。
- 優先度: High（本番破壊防止）。
- 該当 ADR / ファイル例: ADR-0003, drizzle.config.ts, scripts/verify/*.sh, package.json

## 16. Observability（構造化ログ・redact・遷移ログ）
- 観点: pino redact 網羅、state 遷移ログ（from/to/reason）の記録一貫性、識別子（sessionId/weekKey 等）付与率。
- 評価方法: rg 'logger\.(info|warn|error)\(' src で遷移系ログを抽出し項目有無をサンプリング評価。
- 粒度/単位タスク: 「遷移ログフィールド監査」「redact 漏れ確認」。
- 期待成果物: 観測性ギャップ一覧。
- 優先度: Medium-High（障害解析性）。
- 該当 ADR / ファイル例: src/logger.ts, tests/logger/redact.test.ts, src/features/*

## 17. テスト戦略（unit / integration / 回帰）
- 観点: unit は feature/port 中心、integration は DB 契約に限定、regression ケース（ISO week 等）が維持されているか。
- 評価方法: tests/ をカテゴリ別に棚卸し、vitest.integration.config.ts と INTEGRATION_DB gate 確認。
- 粒度/単位タスク: 「テストマップ作成」「未カバー軸抽出（状態遷移/競合/復旧）」。
- 期待成果物: テスト戦略妥当性レビュー計画。
- 優先度: High（設計変更の安全弁）。
- 該当 ADR / ファイル例: ADR-0003/0018, tests/time/jst.test.ts, tests/integration/sessions.contract.test.ts

## 18. 拡張性評価（メンバー数・slot・状態追加）
- 観点: 固定 4 名前提がどこにハードに入っているか、slot/状態追加時の変更波及を予測可能か。
- 評価方法: rg 'MEMBER_COUNT_EXPECTED|T2200|SESSION_STATUSES|RESPONSE_CHOICES' src tests、影響箇所を依存チェーン化。
- 粒度/単位タスク: 「変更シナリオ別 impact map（新メンバー/新時刻/新状態）」。
- 期待成果物: 変更容易性レポート（影響ファイル一覧）。
- 優先度: Medium（将来改修コスト見積もり）。
- 該当 ADR / ファイル例: ADR-0012/0030, src/env.ts, src/db/schema.ts, src/slot.ts

## 19. ドキュメント整合（requirements / ADR / code）
- 観点: 仕様語彙・状態定義・時刻表現が requirements/base.md とコードで一致し、ADR が古いパスを残していないか。
- 評価方法: 仕様キーワードを基点に横断 grep（例: POSTPONE_DEADLINE, CANCELLED, SKIPPED, weekKey）。
- 粒度/単位タスク: 「仕様→実装トレーサビリティ表作成」。
- 期待成果物: drift 候補一覧（要更新 docs/ADR）。
- 優先度: Medium-High（レビュー基準の信頼性）。
- 該当 ADR / ファイル例: ADR-0022, requirements/base.md, docs/adr/README.md

## 20. 循環依存 / module graph
- 観点: 層再編後（ADR-0025〜0029）に循環 import が潜んでいないか。shared↔feature の逆流がないか。
- 評価方法: npx madge --circular src（読み取り専用）または簡易に tsc --noEmit + import graph サンプリング。
- 粒度/単位タスク: 「循環検出実行」「循環ごとの解消方針草案」。
- 期待成果物: 依存グラフ図 + 循環ゼロ/有り判定。
- 優先度: Medium（長期保守性）。
- 該当 ADR / ファイル例: ADR-0026/0029, src/**

# 追加で検討すべき点 / 既存観点の漏れ
- HeldEvent 導入後（ADR-0031）の「DECIDED→COMPLETED 原子化」が旧テスト資産と矛盾していないか（特に scheduler/reminder 系）。
- /status コマンドの存在要件（requirements）と実装有無の乖離確認。
- verify:forbidden ルールの例外パスが増えすぎていないか（ルール実効性の監査）。

# 実装フェーズへの移行時の注意
- 先に「観点ごとの証拠収集テンプレート（grep パターン/対象ファイル/判定基準）」を固定してから実査する。
- High 優先（状態遷移/CAS/interaction/time/DI）から着手し、Medium は差分追跡に回す。
- 指摘は必ず「仕様 or ADR or instruction への参照」とセットで記録し、主観コメントを避ける。
