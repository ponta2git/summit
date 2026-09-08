# AI Document Index

Summit の現行仕様と設計を、必要な範囲だけ安全に読むための入口。AI は最初に `AGENTS.md` と本書を読み、変更対象に対応する文書だけを追加で読む。全ドキュメントの一括読込はしない。

## 1. タスクから文書を選ぶ

| タスク | まず読む | 必要になったら読む |
|---|---|---|
| 業務仕様、状態、締切、順延、週キー | `requirements/base.md` | `docs/time-rule.md`, 対象 feature のコード・テスト |
| 新しい feature / handler / workflow | `docs/architecture.md` | `docs/discord-rule.md`, `docs/test-rule.md`, `docs/dev-rule.md` |
| Discord Interaction / custom ID / 表示 | `docs/discord-rule.md` | `requirements/base.md`, `docs/architecture.md`, `docs/test-rule.md` |
| scheduler / startup / reconnect / outbox worker | `docs/architecture.md` | `docs/db-rule.md`, `docs/time-rule.md`, `docs/test-rule.md`, `docs/operations/scheduler.md` |
| DB repository / transaction / outbox | `docs/db-rule.md` | `docs/architecture.md`, `docs/test-rule.md`, `docs/operations/migration.md` |
| schema / migration | `../momo-db/docs/development.md` と `docs/db-rule.md` | `docs/operations/migration.md`, `docs/test-rule.md` |
| JST / deadline / ISO week / clock | `docs/time-rule.md` | `requirements/base.md`, `src/time/`, `docs/operations/time-skew.md` |
| テスト / CI / fake | `docs/test-rule.md` | `docs/architecture.md`, `docs/dev-rule.md` |
| toolchain / command / 外部 API の資料確認 / naming / comment / Git・PR・Linear | `docs/dev-rule.md` | `docs/test-rule.md` |
| 障害、復旧、backup、rotation | `docs/operations/README.md` | 該当 runbook と設計文書 |
| 文書体系・設計判断・agent 規約の更新 | 本書 | 変更対象の正本文書、`docs/test-rule.md`、agent adapter / PR template / 検証 script |

長い文書は目次と該当章から読む。既に確認した文書は、ファイル名と確認済みの要点を再利用する。検索は対象の path・symbol・test から始め、結果が不足するときに範囲を広げる。

必須の文書や sibling checkout がない場合は、その内容に依存する判断を未確定として扱う。無関係な作業まで停止せず、必要になった依存先と不足内容を示す。索引に載っているだけの文書を、全タスクの前提にしない。

## 2. 文書の責務

| ファイル | 正本とする情報 | 置かない情報 |
|---|---|---|
| `AGENTS.md` | AI の入口、横断的な制約、探索・実装原則、完了条件 | タスク別routing表、詳細な実装・運用規則、command一覧、年代順の判断履歴 |
| `requirements/base.md` | ユーザーに見える業務仕様、用語、状態、締切、順延 | ライブラリ選定、コード配置、運用手順 |
| `docs/README.md` | 読む順、文書境界、競合処理、文書の増減条件 | 各領域の設計本文 |
| `docs/architecture.md` | runtime 構造、依存方向、scheduler、DI、error boundary、設定境界 | schema 詳細、Interaction 詳細、実行リテラル |
| `docs/discord-rule.md` | ack、検証、routing、custom ID、再描画、通知方針 | DB transaction の内部実装、業務時刻 |
| `docs/db-rule.md` | DB 所有権、書込境界、transaction、outbox、migration 契約 | ユーザー向け文言、実行時閾値 |
| `docs/time-rule.md` | JST、ISO week、clock、deadline の実装契約 | 現在の時刻値や cron 式の複製 |
| `docs/test-rule.md` | 変更種別ごとの gate とテスト、fake、race、assertion、agent 規約の確認観点 | 実行コマンドの詳細、production 設計の再説明 |
| `docs/dev-rule.md` | toolchain、コマンド、外部資料の確認、source layout、命名、コメント、Git・PR・Linear | 業務仕様、運用障害 SOP |
| `docs/operations/` | 現在実行可能な運用 SOP | 実装規約、過去の検討メモ |
| `../momo-db/docs/development.md` | momo-db の schema / migration 開発、custom SQL の分離、検証、rollback | Summit 固有の consumer / deploy 手順 |
| `src/config.ts`, `src/env.ts`, `src/userConfig.ts`, `src/time/` | 実行される設定値・parse・時刻計算 | 判断の長い説明 |
| `../momo-db/src/schema.ts`, `../momo-db/drizzle/` | 共有 schema と migration 履歴 | Summit 固有の workflow |

### Agent adapter

`AGENTS.md`をagent protocolの唯一の論理正本とする。toolごとの入口は内容を独自管理せず、次のthin adapterだけを置く。

- `CLAUDE.md`は`@AGENTS.md`だけをimportする。
- `.github/copilot-instructions.md`は`AGENTS.md`の生成mirrorとする。GitHub Copilotの一部surfaceが専用fileだけを読むため、削除せず自動同期する。
- `AGENTS.md`を変えたら`pnpm docs:sync-agent`を実行し、`pnpm verify:docs`で完全一致を確認する。
- 新しいagent tool向け入口が必要になっても、独立した規則集を増やさず、importまたは決定論的生成で接続する。

adapterは配送形式であり正本ではない。生成fileを直接編集した差分はCIでrejectする。

`AGENTS.md`には、どの領域にも共通するagentの行動だけを残す。特定の技術、module、provider、command、時刻、DB操作にだけ適用される規則は、対応するrequirements・設計文書・runbookへ置く。詳細をAGENTSへ再掲して安全性を担保しようとせず、文書mapと決定論的検証で到達性を保証する。

`.github/PULL_REQUEST_TEMPLATE.md` は `docs/dev-rule.md` の報告形式を補助する template とし、独自の承認条件や品質 gate を追加しない。文書の入口・adapter・template を変える場合は、配送先も含めて同じ契約になることを確認する。

## 3. 正本の判定

情報の正本と、作業を実行する権限は別に判定する。指示の扱いは `AGENTS.md` に従い、仕様上の事実は次表で決める。外部のモデルガイダンスやライブラリの推奨だけで、Summit の業務仕様・運用境界を変更しない。

| 情報の種類 | 正本 | 競合時の処理 |
|---|---|---|
| 業務挙動・用語 | `requirements/base.md` | 明示された変更依頼で解消できなければ、依存する実装を止めて期待挙動を確認する |
| 設計上の不変条件・依存方向 | 対応する設計文書 | コード・テストを調べ、許可された設計変更なら同じ変更で整合させる。それ以外は既存契約を守る |
| schema・列・制約 | `momo-db` | Summit 側へ写さず、consumer contract だけを記述する |
| cron・HH:MM・閾値・timeout | 実装コードと設定 | 文書は symbol/path を指し、値を写さない |
| 現在の運用手順 | `docs/operations/` | コード・provider 設定と照合して runbook を直す |
| 過去の理由 | Git / PR 履歴 | 現在の正本としては使用しない |

正本文書同士の矛盾を推測で解消しない。停止が必要なのは未確定の判断・権限に依存する部分であり、独立した調査や検証は継続できる。

| 状況 | 対応 |
|---|---|
| 正本と依頼の範囲内の命名、局所的な実装方法、fixture の構成、文書整理 | 可逆な技術判断として進める。結果に影響する仮定だけを PR または完了報告に残す |
| 締切、週キー、順延、参加条件、状態、custom ID、業務用語の意味が未確定 | その挙動の実装を止め、選択で何が変わるかを示して確認する |
| ユーザーが仕様・設計・規約の変更を明示し、変更後の契約も判断できる | 既存記述との差だけを理由に再承認を求めず、正本と影響する実装・test を一緒に更新する |
| 依頼を満たすために範囲外の機能や設計契約の変更が必要 | 既存契約内で完了できる範囲を進め、追加変更の理由・影響・推奨案を確認する |
| production 破壊、不可逆な secret 変更、単一 instance、deploy 禁止窓に不明点・矛盾がある | 対象操作を直ちに停止する。runbook と明示権限が揃うまで実行しない |

未確定の仕様を draft の差分に示す必要がある場合だけ、`todo(ai): spec clarification needed - <issue>` と PR の要確認事項を対応させる。これは仮の業務挙動を実装したり、未確定のまま完了・merge 可と報告したりする許可ではない。解消時は marker も除去する。

codeを自動的に正しいものとして仕様へ逆輸入しない。競合を解消するときは、情報種別の正本、実装、testを同じ変更で整合させる。

## 4. 設計文書の更新方法

設計判断を変更するときは番号付きの履歴文書を増やさず、現在の正本文書を同じ PR で直接更新する。

変更には必要な範囲で次を含める。

1. 現在採用する規則または不変条件
2. その規則が必要な理由
3. 現在も再提案されやすい非採用案
4. 前提が崩れたと判断する再評価条件
5. 実装・設定・テストへの pointer
6. 変更後に必要な検証

設計判断を変える PR には変更理由、主要な代替案、再評価条件、影響する正本文書を書く。誤字修正に代替案の列挙は不要。過去の状態は Git と PR が保持するため、living document に時系列の追記を積み重ねない。

一時的な互換処理は、現行設計として文書化したうえで、観測可能な撤去条件を必ず書く。期限だけを撤去条件にしない。

## 5. 文書の増減条件

新しい設計文書を作るのは、次のいずれかを満たす場合だけとする。

- 読むべき変更対象が既存文書と明確に異なる。
- 同じ判断規則が 3 箇所以上で重複し、独立した正本が必要になった。
- 文書の所有対象、更新契機、検証方法を一意に説明できる。

既存文書へ統合または削除する条件:

- 読む条件が別文書と同じで、独自の正本性がない。
- コード・設定の値を写しているだけで判断規則がない。
- 過去の実装計画や完了済み移行手順になっている。
- 内容の大半が別文書への pointer になっている。

削除済みの判断資料を調査する必要がある場合だけ、cutover 前の Git 履歴を参照する。復元した古い文書を現在の正本として扱わない。

## 6. 完了時の文書確認

- 変更した挙動と要求正本が一致している。
- 変更した不変条件と設計文書が一致している。
- 実行リテラルを文書へ複製していない。
- コードコメント単体で意味が通り、不要な文書リンクを増やしていない。
- `pnpm verify:docs` と変更種別に応じた品質ゲートが通る。

## 7. Agent 規約の改訂基準

参考: [OpenAI の GPT-6 Astra モデルガイダンス](https://developers.openai.com/api/docs/guides/latest-model) の Prompting best practices（2026-09-08 確認）。確認待ち、指示への感度、報告の詳しさ、委譲、検証量についての公開ガイダンスを改訂の参考とする。モデル内部の思考を推測した説明や、未計測の性能改善を規約の根拠にしない。

規則は「適用条件・行動・完了または停止条件」が読める形にする。強調語、同じ禁止の重複、思考手順の逐語的な指定を増やすより、誤判断が起きる境界を明確にする。`AGENTS.md` のサイズ上限は `scripts/verify/docs.ts` の `AGENTS_MAX_BYTES` を維持し、収まらない領域別の詳細は正本へ移す。

改訂時は [agent 規約の確認シナリオ](./test-rule.md#10-agent-規約の確認) で、通常作業が完了することと、業務・機密・本番の境界で停止できることを review する。構造検査と行動の評価は区別する。モデルや tool が変わった場合、同じ原因で不要な確認・見落とし・検証の反復が観測された場合に、この境界とシナリオを再評価する。モデル名や推奨設定を runtime の採用条件にはしない。
