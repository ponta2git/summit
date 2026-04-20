---
applyTo: "src/commands/**/*.ts,src/**/*interaction*.ts"
---

# Interaction Review Rules

Discord slash command / ボタン押下ハンドラ。3 秒応答 / 検証順 / DB 正本 / 冪等再描画が要。

## 応答フロー（骨格）
1. **入口で即 ack**（3 秒制約）: Component は `interaction.deferUpdate()`、Slash command は `interaction.deferReply({ ephemeral: true })` or `interaction.reply(...)`。
2. **cheap-first 検証**（失敗時は状態変更せず、必要なら ephemeral 却下）:
   1. `interaction.guildId === env.DISCORD_GUILD_ID`
   2. `interaction.channelId === env.DISCORD_CHANNEL_ID`
   3. `interaction.user.id ∈ env.MEMBER_USER_IDS`
   4. Component は `custom_id` を zod `safeParse`、Slash command は `options` を zod で narrow
   5. DB から Session 再取得し `status` が操作を受け付けること
3. 状態更新は **DB トランザクション + 条件付き `UPDATE ... WHERE status = ...`**。`(sessionId, memberId)` unique で競合吸収。
4. **再描画は常に DB の Session + Response から組み立て** `interaction.message.edit(...)` で更新。追加通知のみ `followUp()`。
5. 押下前のメッセージ内容や `custom_id` を信用せず、最新は必ず DB から取り直す。

## Custom ID
- 募集: `ask:{sessionId}:{choice}`（choice = `t2200` / `t2230` / `t2300` / `t2330` / `absent`）
- 順延: `postpone:{sessionId}:{ok|ng}`
- zod で narrow してから使う（生値を信用しない）。

## Slash command 同期
- **Guild-scoped bulk overwrite のみ**（global 禁止: 伝播最大 1 時間で運用事故源）。
- deploy ごとに無条件同期（bulk overwrite は冪等）。

## Discord 最小権限
- OAuth2 scopes: `bot` / `applications.commands`
- Gateway Intents: `Guilds` のみ（`GuildMessages`/`MessageContent`/`GuildMembers` 不要）
- Bot Permissions: `View Channel` / `Send Messages` / `Embed Links`

## API 失敗時の整合性
- DB 更新成功 → `message.edit` 失敗は **DB 正本のまま** 次 cron tick で再描画を試す（DB を巻き戻さない）。
- `messageId` 無効（削除/権限変更）時は新規投稿し Session の参照 ID を更新。
- 再試行に上限を設け超過時はログに残す。
