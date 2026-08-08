# Recovery SOP

自動復旧経路の **case 1〜7** と **復旧不能ケース** の運用手順。状態の正本は DB であることを大前提に、「何もしない / 待つ / Fly redeploy」が第一選択。設計上の復旧不変条件は `docs/architecture.md` と `docs/db-rule.md` を参照する。

## 共通: 何を見るか

```
fly logs -a summit-momotetsu | jq -c 'select(.event != null)'
```

主な `event`:

- `phase=reconcile|login|startupRecovery|scheduler|ready` — 起動 phase
- `outbox.metrics` — scheduler supervisor 実行時の depth/age
- `outbox.dispatch.*` — 個別 dispatch
- `reconciler.*` — invariant 収束ログ
- `interaction.*` — interaction 入口 / reject 理由

`level=warn` 以上を最初に確認。pino redact が token / 接続文字列 / `Authorization` を除去するので、ログをそのままコピペしてよい。

## case 1: bot 再起動直後

**症状**: 何らかの理由で再起動が発生 (Fly maintenance / OOM / deploy)。

**自動復旧**: `runStartupRecovery` (`src/scheduler/index.ts`) が以下を実行する。

1. dead-letter とその取消済み後続を 1 retry cycle だけ再開し、invariant を再収束 (`runReconciler({ scope: "startup" })`)
2. message id が未設定なら delivery intent を補い、Discord 上で削除済みの既存メッセージだけを active probe で再生成する
3. 非終端 session を DB から読み直して締切 / リマインドを再計算

**人手作業**: 不要。`event=phase, phase=ready` が出るのを待つ。

**判断 NG ライン**: 再起動から 60 秒経っても `phase=ready` が出ない → `fly logs` を遡り、`level=fatal` / `phase=reconcile` の例外を確認。直前の deploy が原因なら直前リビジョンへ rollback (`fly releases` → `fly deploy --image <prev>` 不可なので、git revert + redeploy)。

## case 2: Gateway disconnect → reconnect

**症状**: discord.js が `Disconnected` ログを出す。

**自動復旧**: discord.js が自動再接続 → reconnect handler が `runReconciler({ scope: "reconnect" })` を呼ぶ。disconnect 中の状態遷移が Discord に反映される。

**人手作業**: 不要。reconnect が成功しないまま 5 分経過したら case 1 と同じく Fly redeploy。

## case 3: DB 接続瞬断

**症状**: `event=outbox.dispatch.error` 等で postgres.js のエラーが続く。

**自動復旧**: postgres.js の自動再接続。当該 cron tick は最外周 try/catch で log → 次 tick で再試行。状態破綻なし (DB 正本)。

**人手作業**: 5 分以上継続したら Neon dashboard でインスタンス状態確認。Neon 障害なら Neon status page を確認しつつ待機。

## case 4: Discord API rate limit

**症状**: `event=rate.limited` が出る。`/status` で確認すると DB 上は遷移済みだが Discord 表示が遅延。

**自動復旧**: outbox に蓄積 → worker が backoff で retry。状態は DB 側で進行済み。

**人手作業**: 通常不要。`outbox.metrics` の `pending` が `OUTBOX_METRICS_PENDING_WARN_DEPTH` を超えたら [outbox.md](./outbox.md) §警告対応 へ。

## case 5: `message.edit` で 404 (メッセージ削除)

**症状**: 該当メッセージが Discord で削除された / 権限が剥奪された。

**自動復旧**: `DiscordAPIError` code (`src/discord/shared/discordErrors.ts`) で分岐 → invariant C が次 tick で新規投稿 → session の `askMessageId` / `postponeMessageId` を更新。

**人手作業**: 不要。ただし「権限剥奪」が原因の場合は復旧しない (復旧不能ケース 2)。

## case 6: reminder outbox worker crash

**症状**: reminder intent が IN_FLIGHT のまま送信完了しない、または Discord 受理後に process が停止する。

**自動復旧**: claim が `OUTBOX_CLAIM_DURATION_MS` を超えると startup / supervisor が PENDING へ戻し、worker が再取得する。claim token が古い worker の遅延確定を拒否する。Discord 受理と DB 完了の間で停止した場合は、欠落を避けるため再投稿される可能性がある。

**人手作業**: 不要。

## case 7: Fly deploy 中の in-flight

**症状**: 旧 instance 停止中に outbox の未完了 claim が残る。

**自動復旧**: 新 instance 起動時に reconciler / `runStartupRecovery` が DB から再計算。outbox の claim 時刻が `OUTBOX_CLAIM_DURATION_MS` より stale なら release → worker が retry。

**人手作業**: 不要。**ただし金 17:30〜土 01:00 JST のdeploy禁止窓に該当deployをしないこと** (`docs/operations/README.md`)。

## 復旧不能ケース

### A. DB データ破損

schema drift / 手動 UPDATE による破壊。

**SOP**:

1. 状況確認 (どの table のどの session が壊れたか)
2. [backup.md](./backup.md) §restore-pitr で Neon PITR で時点復元
3. 復元後、Fly redeploy で reconciler を流して invariant 再収束

### B. Discord bot 権限剥奪

guild 管理者が bot を kick / channel 権限を剥奪。

**SOP**:

1. guild 管理者に bot を再 invite してもらう (OAuth2 scope: `bot` `applications.commands`)
2. Discord 管理画面で bot に `View Channel` / `Send Messages` / `Embed Links` 付与
3. Fly redeploy で `commands:sync` を再走 → reconciler が新メッセージ投稿で復旧

### C. env 誤設定

zod parse 失敗で `process.exit(1)` → Fly logs の `Failed to start Discord bot.` を確認。

**SOP**:

1. `fly logs -a summit-momotetsu` 末尾の zod error を確認 (どの env が不足/不正か特定)
2. `fly secrets set KEY=...` で修正 (実値は手元のみ、コマンドライン履歴に残さないなら `--stage` で確認後 `--detach` 等を活用)
3. Fly が自動 redeploy → `phase=ready` を確認

### D. migration 失敗

[migration.md](./migration.md) §ロールバック を参照。

## 開発環境のみ: DB reset

ローカル `pnpm db:reset` (`scripts/dev/reset.ts`) は host が `localhost` / `127.0.0.1` / `::1` / `postgres` 以外なら即 throw する safety guard 付き。本番では絶対に動かさない (動かないように作られている)。

```bash
pnpm db:reset           # sessions / responses TRUNCATE (members 保持)
pnpm db:reset --all     # members も TRUNCATE → pnpm db:seed 必須
```
