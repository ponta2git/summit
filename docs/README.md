# AI Document Index

Summit の現行仕様と設計への索引。最初は `AGENTS.md` と本書 §1 から対象の文書を選ぶ。正本の競合は §3、文書体系・agent 規約の改訂は §2 以降を参照する。

## 1. タスクから文書を選ぶ

| タスク | まず読む | 必要になったら読む |
|---|---|---|
| 誤字・リンク・説明だけの修正 | 対象箇所・参照先と `docs/test-rule.md` §8 | 内容の契約も変わる場合は下の該当行 |
| 業務仕様、状態、締切、順延、週キー | `requirements/base.md` | `docs/time-rule.md`, 対象 feature のコード・テスト |
| 新しい feature / handler / workflow | `docs/architecture.md` | `docs/discord-rule.md`, `docs/test-rule.md`, `docs/dev-rule.md` |
| Discord Interaction / custom ID / 表示 | `docs/discord-rule.md` | `requirements/base.md`, `docs/architecture.md`, `docs/test-rule.md` |
| scheduler / startup / reconnect / outbox worker | `docs/architecture.md` | `docs/db-rule.md`, `docs/time-rule.md`, `docs/test-rule.md`, `docs/operations/scheduler.md` |
| OCR・分析通知 / private受付 / 運用retry | `requirements/base.md` §11 と `docs/db-rule.md` | `docs/architecture.md`, `docs/discord-rule.md`, `docs/operations/result-notifications.md` |
| DB repository / transaction / outbox | `docs/db-rule.md` | `docs/architecture.md`, `docs/test-rule.md`, `docs/operations/migration.md` |
| schema / migration | `../momo-db/docs/development.md` と `docs/db-rule.md` | `docs/operations/migration.md`, `docs/test-rule.md` |
| JST / deadline / ISO week / clock | `docs/time-rule.md` | `requirements/base.md`, `src/time/`, `docs/operations/time-skew.md` |
| テスト / CI / fake | `docs/test-rule.md` | `docs/architecture.md`, `docs/dev-rule.md` |
| toolchain / command / 外部 API の資料確認 / naming / comment / Git・PR・Linear | `docs/dev-rule.md` | `docs/test-rule.md` |
| 障害、復旧、backup、rotation | `docs/operations/README.md` | 該当 runbook と設計文書 |
| 文書体系・設計判断・agent 規約の更新 | 本書 §2〜7 と変更対象の正本 | `docs/test-rule.md` §10、agent adapter / PR template / 検証 script |

各行は全文読込の指示ではない。長い文書は見出しと該当章から読み、関連する契約へ進む。検索は対象の path・symbol・test から始め、判断に足る根拠が揃ったら実装・検証へ進む。

必須の文書や sibling checkout がない場合は、その内容に依存する判断だけを未確定として扱い、不足内容を示す。索引に載っているだけの文書を全タスクの前提にしない。migration authoring の必読範囲は `docs/db-rule.md` §1 に従う。

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

特定の技術・module・操作の規則は、上表の正本へ置く。adapter や task prompt、skill に独立した規則集を複製せず、読む条件と参照先を示す。

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

正本文書同士の矛盾は、未確定の判断に依存する部分に限って次表で扱う。

| 状況 | 対応 |
|---|---|
| 正本と依頼の範囲内の命名、局所的な実装方法、fixture の構成、文書整理 | 可逆な技術判断として進める。結果に影響する仮定だけを PR または完了報告に残す |
| 締切、週キー、順延、参加条件、状態、custom ID、業務用語の意味が未確定 | その挙動の実装を止め、選択で何が変わるかを示して確認する |
| ユーザーが仕様・設計・規約の変更を明示し、変更後の契約も判断できる | 既存記述との差だけを理由に再承認を求めず、正本と影響する実装・test を一緒に更新する |
| 依頼を満たすために範囲外の機能や設計契約の変更が必要 | 既存契約内で完了できる範囲を進め、追加変更の理由・影響・推奨案を確認する |
| production 操作の権限や運用前提が未確定 | `AGENTS.md` の境界と `docs/operations/README.md` の準備手順を適用する |

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

変更した文書の責務と正本を §2〜3 で照合し、実行値の複製や古い契約が残っていないことを確認する。gate は [テスト規約 §8](./test-rule.md#8-quality-gate)、agent 規約の整合確認は [同 §10](./test-rule.md#10-agent-規約の確認) を適用する。

## 7. Agent 規約の改訂基準

参考: [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) と [モデルガイダンスの Prompting best practices](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)（2026-09-13 確認）。必要な文脈だけを読み、完了と権限の境界を明確にする方針を Summit へ適用する。

改訂では、規則ごとに次の基準で残す場所と必要性を判断する。

- **共通契約**: `AGENTS.md` は成果物、判断・権限の境界、完了条件を示す。探索順や思考手順を逐一指定しない。`AGENTS_MAX_BYTES`（`scripts/verify/docs.ts`）は上限であり、埋める目標ではない。
- **領域固有の規則**: 正本に、適用条件・守る不変条件・必要な検証を置く。実際の依存順、migration や運用の必須手順は保ち、無関係な変更への適用を狭める。
- **task prompt**: 今回の目的、成果物、成功判定、制約、必要な参照先を伝える。探索の継続を求めるなら対象と終了条件を指定し、一回限りの作業計画を恒久規約へ昇格させない。
- **skill**: repository 管理の skill を追加・改訂する場合、description は対象作業と使う条件を短く示す。広い関連語や強調で選択を誘導しない。複数 workflow は入口を小さな索引にし、詳細・script は利用時だけ読む構成にする。
- **不要な規則**: 重複、古い回避策、観測する失敗を説明できない一般論は削る。同じ問題への禁止を追記する前に、既存規則の競合や過剰な適用範囲を直す。

skill catalog、`AGENTS.md`、参照文書、adapter、PR template を一連の指示として照合する。repository 外で配布される skill や実行環境の制約は、ローカル規約を書き換えて無効化した扱いにしない。選択の衝突や不要な停止が残れば、その所在と影響を報告する。

モデルや tool の変更時、不要な確認・見落とし・過剰読込・検証の反復が観測されたときに、該当規則と §6 の確認を再評価する。複数モデルで使う共通契約を保ち、モデル名・推奨設定を runtime の採用条件にしない。構造の合格や規約の短縮を、未計測の行動・性能改善と同一視しない。
