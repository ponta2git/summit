# Backup & Restore

Summit の DB は Neon PostgreSQL 16 を使用する。本ファイルは backup / restore 方針と想定 RPO/RTO をまとめる。

関連 ADR: 0008 (Drizzle + postgres.js 採用)

## 方針

- **バックアップは Neon の PITR (Point-in-Time Recovery) に全面依存**。Summit 側でダンプ / スナップショットは取らない
- Neon の保持期間は plan 依存 (現行は free/pro の default を使用)。保持期間が短くなるほど RPO が長くなる点に注意
- `fly ssh` 等で `pg_dump` を手動実行することも可能だが、secrets 取扱いが煩雑になるため **通常運用では使わない**

## 想定 RPO / RTO

個人開発 Bot の業務特性 (固定 4 名、週 1 回の桃鉄出欠) を踏まえ、以下を目標とする:

| 指標 | 目標 | 根拠 |
|---|---|---|
| RPO | 数分以内 | Neon PITR の粒度 |
| RTO | 1 時間以内 (業務時間帯) | Neon restore + Fly redeploy |
| 許容 data loss | 1 週分の session / responses 全損失まで | reconciler が次週以降を自動再生成できる |

**重要**: 金曜募集 → 土曜順延のサイクル中に DB が壊れた場合でも、members テーブルさえ残っていれば reconciler が次週以降を自動で組み立てる。「今週を復旧できなくても来週は動く」設計 (ADR-0033)。

## restore-pitr 手順

### 1. 影響範囲の把握

- どの時点まで戻せば済むか決定 (migration 失敗 / 破損 commit / 手動 UPDATE 事故など)
- 戻すと失われる正常データの有無を確認 (PITR は時点復元なので、戻した後の正常データは消える)

### 2. Fly app 停止 (推奨)

復旧中にアプリが書き込みを続けると PITR 後の状態が壊れるので、一旦止める:

```bash
fly scale count 0 -a summit-momotetsu
```

### 3. Neon dashboard で PITR 実行

- Neon console → Project → Branches → Restore to a point in time
- 戻したい時刻を指定 (UTC / JST 表記に注意)
- 新ブランチとして復元するのが安全 (既存 main branch を直接書き換えない)
- 新ブランチの接続文字列を取得

### 4. 接続文字列の切り替え

- `fly secrets set DATABASE_URL=... -a summit-momotetsu`
- **旧接続文字列は即 rotate** ([secrets-rotation.md](./secrets-rotation.md))

### 5. Fly app 再起動

```bash
fly scale count 1 -a summit-momotetsu
fly deploy -a summit-momotetsu   # 必要に応じて
```

### 6. 整合性確認

- `fly logs` で `phase=ready` 確認
- `momo-db` で `pnpm db:check` 相当を確認（Neon console またはローカル実行）
- `/status` を Discord で叩き、正常応答
- outbox metrics (`event=outbox.metrics`) が平常値

### 7. 旧 Neon ブランチの整理

- 復旧が成功して落ち着いたら旧 main branch を deprecated 化 / 削除
- PITR で復旧した branch を main に昇格 or DATABASE_URL 参照を恒久化

## 手動 pg_dump (非常用)

Neon 障害で PITR が使えない場合の last resort。**secrets 露出リスクが高いので必ず一時環境で実施**:

```bash
# 個人開発端末で実施 (本番 DB に直接つなぐ)
export DATABASE_URL="<direct url>"  # shell history に残さないこと
pg_dump --no-owner --no-acl "$DATABASE_URL" > /tmp/summit-$(date +%Y%m%d-%H%M).sql
# 使用後は dump ファイルを安全に削除 (shred 等)
```

dump ファイルは secrets 相当。PR / commit / 共有ドライブに置かない。

## バックアップ検証

個人開発の規模では定期的な restore リハーサルは実施しない。代わりに:

- Neon PITR が有効になっていることを四半期ごとに dashboard で確認
- migration 時に `momo-db` の `pnpm db:check` で schema drift を自動検出
- integration テストが `momo-db` の `pnpm db:migrate` を毎 CI 実行で verify
