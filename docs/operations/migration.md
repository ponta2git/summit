# Migration Operations

Summit consumer から見た schema migration の連携・適用・復旧手順。

> **重要**: schema 定義・migration ファイル・drizzle.config.ts は `../momo-db` リポジトリで管理する。
> summit の `src/db/schema.ts` は `momo-db` の re-export shim になった。
> migration の authoring、通常 / custom SQL の分離、履歴の不変性、検証、rollback は `../momo-db/docs/development.md` が正本であり、本書では再定義しない。

設計正本: `docs/db-rule.md`。schema と migration 履歴の正本は `../momo-db`、開発手順の正本は `../momo-db/docs/development.md`。

## 原則 (常時ルール再掲)

- momo-db を変更する前に `../momo-db/docs/development.md` を全文確認する。欠落・矛盾時は変更や DB 操作を進めない。
- migration は momo-db の履歴として適用する。**`drizzle-kit push` は禁止**。設計契約は `docs/db-rule.md` を参照する。
- `DIRECT_URL` は momo-db の `drizzle.config.ts` 専用 (アプリ code から参照禁止)。
- 金 17:30〜土 01:00 JST は migration 禁止 (`docs/operations/README.md`のdeploy禁止窓)。
- `momo-db` CI の build / check、production approval、migration を別の結果として確認する。

## Summit consumer の更新と検証

1. `../momo-db/docs/development.md` に従い、momo-db で migration の分類、生成、SQL / metadata review、fresh / existing DB 検証、build、commit を完了する。
2. `@momo/db` の build 成果物を Summit へ反映する。
3. Summit consumer の型と挙動を検証する。

   ```bash
   cd ../summit
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```

4. 対象の momo-db migration を適用した disposable PostgreSQL に接続し、real DB consumer contract を検証する。local 実行できない場合も、同じ migration を適用する Summit CI の `integration-db` 完了を必須とする。

   ```bash
   pnpm test:integration
   ```

Summit 側の gate 成功を、momo-db migration 自体の実行証拠として代用しない。

### Fail-closed preflight を持つ migration

Session aggregate / ordered outbox migration は、重複 dedupe key と未対応 outbox kind を検出すると transaction を中断する。旧 reminder claim marker は監査値を保持したまま migration を通し、アプリ側の outbox recovery で再配送する。

- dedupe key / outbox kind の guard を削除・迂回して再実行しない。
- 対象行を read-only query で特定し、backup を確認する。
- 解消方法を momo-db の正規文書に従う別 migration としてレビューする。
- preflight 失敗時は application deploy を進めない。

## 本番への適用

> **注意**: Fly.toml の `release_command` は削除済み。migration は Summit deploy とは独立して先行適用する。

1. momo-db の対象 commit で build / check が成功していることを確認する。
2. protected environment `production-db` で対象 commit の migration を承認する。
3. 接続 preflight と `Migrate Neon` の完了を確認する。
4. migration 適用済みの schema で Summit consumer gate を確認してから Summit を deploy する。

通常運用で CI approval / preflight を手動実行により迂回しない。CI 自体を復旧できない緊急時だけ、momo-db README と `docs/development.md` の明示承認・backup・preflight 条件に従う。

### 共有通知への停止切替

共有通知への再構成と通知業務関数の撤去は、DB・Summit・momo-result APIを同じ停止期間で切り替える。0044/0045以降は取消triggerと通知SQL関数がなく、全writerのアプリcommandが更新境界を所有する。

1. momo-db の [通知契約](../../../momo-db/docs/discord-notifications.md) と対応 commit を確認し、利用者への通知後に API・worker・Summit の全 writer / 配送を停止する。
2. 復元確認済み backup と、直前の開催・参加者・試合の ID / 値・参照を比較する基準を揃える。進行中 Session と未配送・再試行対象の通知を再確認する。
3. 通常のproduction approval / preflightでmigrationを適用し、対応する`@momo/db`を含むSummitと、通知取消を同じ業務transactionへ含めるmomo-result APIを切り替える。旧通知関数を呼ぶconsumerを残さない。
4. 開催履歴の保全と、募集・週取消・リマインド配送後の開催 / 参加者作成を確認してから再開する。新しい A/B は設定・HTTP 受付・配送対応が揃ってから producer を有効化する。

停止中に戻す場合は DB と consumer を整合する組合せで復元する。再開後は新規データを守る forward fix を原則とする。過去の Session から不明な開催を補完せず、現存する開催履歴を維持する。

A/Bのrenderer・宛先・部分計画も保存済み通知と対応させる。旧計画のdelivery contextが不明な場合は推測せず[通知運用](result-notifications.md#移行とrenderer互換性)に従う。

**禁止**: `fly ssh` 経由で生 SQL (`DROP` / `TRUNCATE` / 手動 `UPDATE`) を流すこと (`docs/db-rule.md`)。

## ローカル開発 (setup 経由)

`summit` の `setup` スクリプトがプロジェクト全体を一括セットアップする:

```bash
# summit ディレクトリで
pnpm setup
# = momo-db install+build+db:up+db:migrate → summit install → db:seed
```

postgres コンテナ（`compose.yaml`）は momo-db で管理する。`db:up`/`db:down` は momo-db で実行。

ローカルの `pnpm db:reset` は Session・開催・参照する試合に加え、共通通知の本文と dedupe も初期化する開発専用操作である。履歴を保全する migration の検証には使わない。

## ロールバック

rollback / recovery の DB authoring と data protection は `../momo-db/docs/development.md` に従う。Summit は consumer compatibility と deploy 順序を担当する。

### A. 新 migration を前に進める形で打ち消す (推奨)

適用済み migration を編集せず、momo-db の新しい forward migration で互換な schema へ収束させる。

手順:

1. Summit の現在版と rollback 対象版が読み書きできる互換 shape を確認する。
2. momo-db の正規手順で forward migration を作成・検証・適用する。
3. migration 完了後に対応する Summit version を deploy する。

### B. Neon PITR で時点復元 (B は A が困難な場合のみ)

データ欠損を伴う migration を戻したいなら、momo-db の data-first recovery と [backup.md](./backup.md) §restore-pitr を組み合わせ、復元 copy で schema と consumer を検証する。

## migration 失敗時の復旧 (復旧不能ケース D)

**症状**: `pnpm db:migrate` が途中で失敗し、`__drizzle_migrations` テーブルと schema 実体がずれる。

**SOP**:

1. **焦らない**。application deploy を止め、失敗した migration をその場で再実行しない
2. Neon dashboard の read-only inspection で schema 実体と `__drizzle_migrations` の状態を確認する
3. transaction が rollback 済みでも、master または保持対象 DB で共有済みの migration file は編集しない。momo-db の正規手順で forward recovery を作り、復元 copy と CI で再検証する
4. 部分適用や data loss が疑われる場合は、手動 SQL や `__drizzle_migrations` への手 INSERT を行わず、[backup.md](./backup.md) の PITR で新 branch へ復元する。前進修復が必要なら、momo-db の review 済み追加 migration として作成する
5. 整合後、momo-db の `pnpm db:check`、Summit integration test、`/status`、構造化ログを確認する
6. 事後に PR または incident 記録へ原因と再発防止を残す。設計不変条件や SOP が変わる場合は `docs/db-rule.md` と本書を同時に更新する

**原則**: 本番 migration 失敗は **事故案件**。復旧のためでも production DB の手動 mutation を行わない。

## CI での検査

- `momo-db` CI: `db:check` で migration 履歴の整合性検証
- `momo-db` CI: `drizzle/` 変更時に production approval 後だけ migration 実行
- `summit` CI `integration-db` ジョブ: 実 postgres service に `momo-db` の `pnpm db:migrate` を流して integration テスト実行

これらが全 green になってから本番 deploy する。
