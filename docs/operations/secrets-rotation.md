# Secrets Rotation

Fly secrets として管理される秘匿値の rotation 手順と影響範囲。関連 instruction: `.github/instructions/secrets-review.instructions.md`。

## 対象 secrets

| Key | 用途 | rotation 影響範囲 |
|---|---|---|
| `DISCORD_TOKEN` | Bot ログイン | Gateway 再接続、cmd 再登録は不要 |
| `DATABASE_URL` | アプリの DB 接続 (Neon pooled) | 再起動で再接続、cron tick 数回スキップあり |
| `DIRECT_URL` | migration 専用 (`drizzle.config.ts`) | 本番アプリへの影響なし。次回 migration で使用 |
| `HEALTHCHECK_PING_URL` | healthchecks.io の ping URL | 未設定時は no-op。誤設定で alert が鳴らない点に注意 |
| `FLY_API_TOKEN` (CI) | GitHub Actions から Fly deploy | app-scoped deploy token のみ。Personal Auth Token 禁止 |

## 共通原則 (再掲)

- 実値を **コード / fixture / ログ / PR / コミットに載せない** (`.github/instructions/secrets-review.instructions.md`)
- commit 可能な env は `.env.example` の placeholder のみ
- `fly secrets unset` / 既存 secrets **上書きは不可逆変更** — ad-hoc 禁止、事前通知 + 停止窓外 + 手順書でのみ
- ログに実値を出さないため `logger.redact` で token / 接続文字列 / `Authorization` を除去 (ADR / `src/logger.ts`)

## rotation の基本手順

### 1. 新しい値を準備

- `DISCORD_TOKEN`: Discord Developer Portal → Bot → Reset Token
- `DATABASE_URL` / `DIRECT_URL`: Neon dashboard → Connection string (pooled / direct)
- `HEALTHCHECK_PING_URL`: healthchecks.io → Check → Ping URL
- `FLY_API_TOKEN`: `fly tokens create deploy --app summit`

### 2. Fly secrets に反映

```bash
fly secrets set DISCORD_TOKEN="<new>" -a summit
```

複数同時に入れ替える場合は 1 コマンドで:

```bash
fly secrets set DATABASE_URL="<new>" DIRECT_URL="<new>" -a summit
```

Fly は secrets 更新で自動 redeploy する (stage してから手動 deploy したい場合は `--stage` + `fly deploy`)。

### 3. 反映確認

- `fly logs -a summit` で `phase=ready` 確認
- Discord で `/status` 応答確認
- healthchecks.io の ping が到達しているか dashboard で確認

### 4. 旧値の無効化

- **Discord token**: reset した時点で旧 token は即無効 (Discord 側で失効)
- **Neon connection**: Neon dashboard で旧 role password を変更、または branch を分ける方法がある。ローテーション直後に Neon console から古い connection を revoke
- **FLY_API_TOKEN**: `fly tokens revoke <token_id>` で明示的に無効化

### 5. 漏洩時の追加対応

PR / ログ / commit に実値が混入してしまった場合:

1. **即座に rotate** (上記手順で新しい値に置換)
2. 漏洩した git 履歴を確認。push 済みなら `git rebase` で消しても GitHub 側の reflog / PR diff に残る前提で動く (公開前提)
3. 関連 event を audit:
   - Discord: Bot activity (不正 login / API call)
   - Neon: DB access log、不審クエリ有無
   - Fly: `fly logs` で不審 deploy / SSH の有無
4. 事後に PR 説明か ADR で経緯を記録 (AGENTS.md ADR プロトコル)

## 禁止窓

金 17:30〜土 01:00 JST は rotation (= 実質 restart) 禁止。漏洩が疑われる場合は例外的に即実施し、事後記録を残す (recovery より security を優先)。

## 不可逆操作のチェックリスト

以下を実行する前に必ず停止窓外かつ差戻し手順を用意してから行う:

- [ ] `fly secrets unset KEY`: unset 後に再度 set が必要。アプリは unset 時点で env parse に失敗する可能性 (zod validation)
- [ ] 既存 secrets の overwrite: 誤った値を入れると即座に本番障害
- [ ] `fly tokens revoke`: CI が使えなくなる → deploy 不可

stage deploy (`fly secrets set --stage` + `fly deploy`) を活用して反映タイミングを制御できる。

## CI secrets

GitHub Actions の Secrets (`FLY_API_TOKEN` 等):

- Repository → Settings → Secrets and variables → Actions
- 原則 app-scoped `deploy` token のみ登録。Personal Auth Token は登録しない
- 期限切れや漏洩疑いで rotate した場合は `fly tokens list` / `fly tokens revoke` を組み合わせて旧 token を失効
