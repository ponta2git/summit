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
| schema / migration | `docs/db-rule.md` と `../momo-db` | `docs/operations/migration.md`, `docs/test-rule.md` |
| JST / deadline / ISO week / clock | `docs/time-rule.md` | `requirements/base.md`, `src/time/`, `docs/operations/time-skew.md` |
| テスト / CI / fake | `docs/test-rule.md` | `docs/architecture.md`, `docs/dev-rule.md` |
| toolchain / command / naming / comment | `docs/dev-rule.md` | `docs/test-rule.md` |
| 障害、復旧、backup、rotation | `docs/operations/README.md` | 該当 runbook と設計文書 |
| 文書体系・設計判断の更新 | 本書 | 変更対象の正本文書 |

長い文書は目次と該当章から読む。既に確認した文書は、ファイル名と確認済みの要点を再利用する。

## 2. 文書の責務

| ファイル | 正本とする情報 | 置かない情報 |
|---|---|---|
| `AGENTS.md` | AI の入口、禁止事項、停止条件、完了条件 | 詳細な実装設計、年代順の判断履歴 |
| `requirements/base.md` | ユーザーに見える業務仕様、用語、状態、締切、順延 | ライブラリ選定、コード配置、運用手順 |
| `docs/README.md` | 読む順、文書境界、競合処理、文書の増減条件 | 各領域の設計本文 |
| `docs/architecture.md` | runtime 構造、依存方向、scheduler、DI、error boundary、設定境界 | schema 詳細、Interaction 詳細、実行リテラル |
| `docs/discord-rule.md` | ack、検証、routing、custom ID、再描画、通知方針 | DB transaction の内部実装、業務時刻 |
| `docs/db-rule.md` | DB 所有権、書込境界、transaction、outbox、migration 契約 | ユーザー向け文言、実行時閾値 |
| `docs/time-rule.md` | JST、ISO week、clock、deadline の実装契約 | 現在の時刻値や cron 式の複製 |
| `docs/test-rule.md` | 変更種別ごとのテスト、fake、race、assertion の契約 | 実行コマンドの詳細、production 設計の再説明 |
| `docs/dev-rule.md` | toolchain、コマンド、source layout、命名、コメント、Git | 業務仕様、運用障害 SOP |
| `docs/operations/` | 現在実行可能な運用 SOP | 実装規約、過去の検討メモ |
| `src/config.ts`, `src/env.ts`, `src/userConfig.ts`, `src/time/` | 実行される設定値・parse・時刻計算 | 判断の長い説明 |
| `../momo-db/src/schema.ts`, `../momo-db/drizzle/` | 共有 schema と migration 履歴 | Summit 固有の workflow |

## 3. 正本の判定

単一の「常にコードが最優先」という規則は使わない。情報の種類で正本を決める。

| 情報の種類 | 正本 | 競合時の処理 |
|---|---|---|
| 業務挙動・用語 | `requirements/base.md` | 実装を止め、仕様とコードのどちらを直すか確認する |
| 設計上の不変条件・依存方向 | 対応する設計文書 | コード・テストを調べ、同じ PR で整合させる |
| schema・列・制約 | `momo-db` | Summit 側へ写さず、consumer contract だけを記述する |
| cron・HH:MM・閾値・timeout | 実装コードと設定 | 文書は symbol/path を指し、値を写さない |
| 現在の運用手順 | `docs/operations/` | コード・provider 設定と照合して runbook を直す |
| 過去の理由 | Git / PR 履歴 | 現在の正本としては使用しない |

正本文書同士が矛盾した場合、AI は推測で優先順位を付けない。破壊的操作、secret、単一インスタンス、deploy 禁止窓に関わる矛盾は即時停止する。その他の業務仕様は `todo(ai): spec clarification needed - <issue>` と PR の要確認事項に記録する。

## 4. 設計文書の更新方法

設計判断を変更するときは番号付きの履歴文書を増やさず、現在の正本文書を同じ PR で直接更新する。

変更には必要な範囲で次を含める。

1. 現在採用する規則または不変条件
2. その規則が必要な理由
3. 現在も再提案されやすい非採用案
4. 前提が崩れたと判断する再評価条件
5. 実装・設定・テストへの pointer
6. 変更後に必要な検証

PR 本文には変更理由、検討した代替案、再評価条件、影響する正本文書を書く。過去の状態は Git と PR が保持するため、living document に時系列の追記を積み重ねない。

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
