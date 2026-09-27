# Documentation index

必要な契約を探すための索引。対象と参照先が分かっていれば直接その章を読む。文書の改訂時は §2・§4〜7、仕様と実装の競合時は §3 を使う。

## 1. タスクから文書を選ぶ

| 判断すること | 参照先 | 範囲を広げる条件 |
|---|---|---|
| 誤字・リンク・説明の修正 | 対象箇所・参照先 | 契約の意味も変わるなら下の該当行 |
| 状態、締切、順延、参加条件、週キー | `requirements/base.md` の該当仕様 | 時刻計算は `docs/time-rule.md` |
| feature / handler / workflow の境界 | `docs/architecture.md` §2〜5 | Discord の応答や入力も変わるなら `docs/discord-rule.md` |
| Interaction、custom ID、表示・通知 | `docs/discord-rule.md` の該当章 | 業務挙動は `requirements/base.md`、永続化は `docs/db-rule.md` |
| scheduler、startup、reconnect、shutdown | `docs/architecture.md` §6 | 永続化・競合は `docs/db-rule.md`、実障害は該当 runbook |
| OCR・分析通知の受付・配送 | `requirements/base.md` §11、`docs/db-rule.md` | 接続・起動は `docs/architecture.md`、運用 retry は `docs/operations/result-notifications.md` |
| repository、transaction、outbox | `docs/db-rule.md` の該当章 | schema / migration 自体を変えるときだけ次の行 |
| schema / migration の作成・変更 | `docs/db-rule.md` §1、`../momo-db/docs/development.md` | 適用・復旧は `docs/operations/migration.md` |
| JST、deadline、ISO week、clock | `docs/time-rule.md`、`src/time/` | 業務上の意味は `requirements/base.md` |
| test、fake、race、CI | `docs/test-rule.md` の該当章 | 検証対象の契約が不明なら領域の正本 |
| command、外部資料、命名、Git・PR・Linear | `docs/dev-rule.md` の該当章 | 品質 gate は `docs/test-rule.md` §8 |
| 障害調査、本番操作、復旧 | `docs/operations/README.md` から該当 runbook | 操作の原因や設計を変える場合だけ領域の正本 |
| agent 規約・skill・文書体系 | 本書 §2・§4〜7、変更対象 | 確認シナリオは `docs/test-rule.md` §10 |

関連文書が列挙されていても全件読込は不要。変更の検証は [テスト規約 §8](./test-rule.md#8-quality-gate) で選ぶ。参照先や sibling checkout がないときは、それに依存する判断だけを未確定とし、独立した作業を続ける。migration authoring の読取範囲は `docs/db-rule.md` §1 に従う。

## 2. 文書の責務

一つの契約を一箇所で管理し、他の文書からは適用条件と参照先を示す。

| ファイル | 所有する情報 |
|---|---|
| `AGENTS.md` | 依頼の完了、判断・権限の境界、必要な根拠と報告 |
| `requirements/base.md` | ユーザーに見える業務仕様、用語、状態、締切、順延 |
| `docs/README.md` | 文書の選択・所有権・競合解消・保守方針 |
| `docs/architecture.md` | runtime 構造、依存方向、scheduler、DI、error・設定境界 |
| `docs/discord-rule.md` | ack、入力検証、routing、custom ID、再描画、通知 |
| `docs/db-rule.md` | DB 所有権、書込境界、transaction、outbox、migration の consumer 契約 |
| `docs/time-rule.md` | JST、ISO week、clock、deadline の計算契約 |
| `docs/test-rule.md` | テスト設計、変更別 gate、agent 規約の確認シナリオ |
| `docs/dev-rule.md` | toolchain、command、資料確認、source layout、命名、comment、Git・PR・Linear |
| `docs/operations/` | 実行可能な運用 SOP、禁止窓、操作後の確認と復旧 |
| `../momo-db/docs/development.md` | schema / migration authoring、custom SQL、検証・rollback |
| `src/config.ts`, `src/env.ts`, `src/userConfig.ts`, `src/time/` | 実行される設定値・parse・時刻計算 |
| `../momo-db/src/schema.ts`, `../momo-db/drizzle/` | 共有 schema と migration 履歴 |

### Agent adapter と skill

共通の作業契約は `AGENTS.md` に集約する。`CLAUDE.md` は `@AGENTS.md` の import、`.github/copilot-instructions.md` は生成 mirror とし、独立して編集しない。変更時は `pnpm docs:sync-agent` で同期・検証する。新しい tool の入口も import または決定論的な生成で接続する。

現在、repository 管理の独自 skill はない。領域文書と runbook が専門手順を持ち、`skills-lock.json` の `skills` も空である。skill を追加する条件は §7 に従う。外部配布の skill や個人設定を、この repository の変更だけで改訂済みと扱わない。

PR template は `docs/dev-rule.md` §9 の報告を補助する。adapter・skill・template に品質 gate や承認条件を別途定義しない。

## 3. 正本の判定

事実の正本は §2 で選び、実行権限は `AGENTS.md` で判断する。コードに実装されているだけで業務仕様を上書きせず、外部モデルガイドやライブラリ推奨も Summit の契約変更の許可にはしない。

| 不一致・不足 | 判断 |
|---|---|
| 命名、局所的な実装方法、fixture、文書配置 | 依頼と既存契約の範囲内なら可逆な技術判断として解消する |
| 締切、週キー、順延、参加条件、状態、custom ID、業務用語の意味 | `requirements/base.md` と領域の正本を確認し、依頼からも決められない挙動だけ確認する |
| 明示された仕様・設計変更と旧記述 | 変更後の契約を判断できるなら、正本・実装・test を同じ変更で揃える |
| schema、列、制約 | momo-db を確認する。Summit に写さず consumer 契約を整合させる |
| cron、HH:MM、閾値、timeout | 実装と設定を確認する。文書は値の複製を symbol / path への参照に置き換える |
| runbook と実装・provider 設定 | 現状を照合して手順を直す。権限や運用前提が不明な実操作は保留する |
| 範囲外の機能・契約変更が必要 | 追加差分の理由・影響・推奨案を具体化し、その部分の判断を求める |

未確定の業務挙動を仮実装しない。draft に未解決点を残す必要があるときだけ、`todo(ai): spec clarification needed - <issue>` と PR の要確認事項を対応させ、解消時に取り除く。marker を置いても完了・merge 可の根拠にはならない。過去の判断は Git / PR 履歴で調べ、現在の正本と区別する。

## 4. 設計文書の更新方法

現行の正本を同じ変更で更新する。契約を変える場合は、採用する不変条件と理由、実装・test への参照、必要な検証を記す。再提案されやすい代替案と、前提が崩れる再評価条件も判断に必要な分だけ残す。誤字修正には設計説明を追加しない。

一時的な互換処理には、観測可能な撤去条件を書く。期限だけでは条件にしない。過去の状態は Git / PR が保持するため、番号付きの履歴文書や完了済み計画を蓄積しない。

## 5. 文書の増減条件

新しい文書は、対象作業・所有する契約・更新契機・検証方法を説明でき、既存の正本とは読む条件が異なる場合に作る。同じ判断規則が複数箇所に散在していれば、最も適した正本へ集約する。

読む条件が同じ文書、実行値だけの写し、完了済み移行計画、参照先を重ねるだけの文書は統合・削除する。削除前に参照元を確認し、古い資料が必要なら Git 履歴で調べる。

## 6. 完了時の文書確認

変更箇所と参照先・配送先で契約が一致することを確認する。gate は [テスト規約 §8](./test-rule.md#8-quality-gate)、規約の判断は [同 §10](./test-rule.md#10-agent-規約の確認) で確認する。構造検査の合格と、実際の agent の行動改善は区別する。

## 7. Astra 向けの指示設計

OpenAI Docs を用いて [GPT-6 Astra のモデルガイダンス](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) と [skills / AGENTS.md の見直しガイド](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) を確認した（2026-09-27）。以下は Summit への適用方針であり、モデル名や API パラメータを runtime の採用条件にはしない。

- **完了と裁量**: 求める成果物と終了条件を示す。通常の修正・検証を進められる範囲を明確にし、初稿の確認や再承認を工程に挟まない。
- **文脈の選択**: 常時読む入口には横断する契約だけを置く。領域の詳細は作業条件で選び、モデルが既にできる探索・思考の手順を逐一指定しない。
- **確認と停止**: 未確定の業務判断・未許可の副作用へ条件を絞る。停止規則は具体的な操作と理由を持ち、独立した作業の停止へ波及させない。
- **検証の終了**: 変更が壊し得る契約と必須 gate を確認したら終える。文言を写すだけの test や、合格後の根拠のない反復を増やさない。
- **委譲と報告**: 許可された並列作業には所有範囲と統合責任を設ける。説明は結果・理由・検証を中心にし、作業実況や定型見出しを増やさない。

### Skill を追加・改訂するとき

繰り返す専門作業に、既存文書への参照だけでは得られない選択基準・手順・再利用資源が必要な場合に skill 化する。通常の実装や文書修正を一律に skill 経由にしない。

description は「何をするか・いつ使うか」を短く書く。誤選択しやすい隣接作業だけを除外し、広い関連語や強い表現で利用を誘導しない。`SKILL.md` は目的と固有の制約を中心にし、複数の実質的な workflow がある場合だけ参照先へ分ける。必須の依存順・危険な操作の手順は保ち、共通規約と正本は複製しない。

適用する依頼と適用しない依頼で選択を確認し、一般的な skill 指針がユーザーの許可済み作業を止めないかを見る。外部配布の skill に問題が残る場合は、その所在と影響を報告する。新しい規則を足す前に、重複・古い回避策・過剰な適用範囲を削る。

モデル・tool の変更時、不要な停止・過剰読込・見落とし・検証反復を観測したときに再評価する。`AGENTS_MAX_BYTES`（`scripts/verify/docs.ts`）は上限であり目標ではない。短縮率や構造検査だけで、未計測の性能改善を主張しない。
