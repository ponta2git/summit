# 2026-04-21 包括レビュー (Architecture / Performance / Security)

Fleet 実行による全量レビューの保存アーカイブ。正本は `final-report.md`。

## 結論 (抜粋)
- **Critical 1**: C1 CANCELLED 宙づり (該当週が失われる、翌週は新 `weekKey` で継続)
- **Near-Critical 1**: N1 週次 ask publication / recovery gap (restart / send 失敗 / Discord message 削除)
- High 3 / Medium 約 23 / Low/Info 約 15

## P0 推奨
1. Invariant-based startup reconciler (C1 + N1 + H1 を一括吸収、Discord message 存在検証含む)
2. `transitionStatus` を edge-specific state API に置換
3. `/status` command 実装 (runbook / 運用観測の土台)

## ディレクトリ構成
| Path | 内容 |
|---|---|
| `final-report.md` | R9 反映済の最終統合レポート (SSoT) |
| `plan.md` | R1-R9 Phase 計画 (実行履歴) |
| `arch-brainstorm.md` / `arch-second-opinion.md` | Architecture 観点洗い出し + セカンドオピニオン |
| `perf-brainstorm.md` / `perf-second-opinion.md` | Performance 観点 |
| `sec-brainstorm.md` / `sec-second-opinion.md` | Security 観点 |
| `findings/TA*.md` | Architecture 詳細 findings (TA1-TA8) |
| `findings/TP*.md` | Performance 詳細 findings (TP1-TP7) |
| `findings/TS*.md` | Security 詳細 findings (TS1-TS6) |
| `r7-cluster-critique.md` | R7 GPT-5.4 cluster critique |
| `r7-haiku-critique.md` | R7 Haiku spot critique |
| `r9-final-critique.md` | R9 GPT-5.4 final critique (最終反映根拠) |

## モデル配分
- Haiku 4.5: 単純 finding (一部は上位モデルの再レビュー付き)
- GPT-5.3-Codex High: メイン実装レビュー
- GPT-5.4 High: タスク分解 / cluster critique / final critique
- Opus 4.7: R8 統合 / 全体オーケストレーション
