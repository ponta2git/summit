---
applyTo: "src/commands/**/*.ts,src/**/*interaction*.ts"
---

# Interaction Review Rules

Discord interaction は 3 秒以内応答・検証順序・DB 正本・冪等再描画が要。本書は slash command / ボタン押下ハンドラに適用する。

## Required patterns

### 応答フロー（骨格）
1. **入口で即応答する**（3 秒制約）:
   - **Component / Button interaction**: `interaction.deferUpdate()` でメッセージ編集前提の ack。
   - **Slash command**: `interaction.deferReply({ ephemeral: true })` または `interaction.reply(...)` で ack。ephemeral で却下する場合も同様。
2. **cheap-first で検証**する（失敗時は状態変更せず、必要に応じ ephemeral で却下）:
   1. `interaction.guildId === env.DISCORD_GUILD_ID`
   2. `interaction.channelId === env.DISCORD_CHANNEL_ID`
   3. `interaction.user.id ∈ env.MEMBER_USER_IDS`
   4. **Component interaction のみ** `custom_id` を `zod` で `safeParse`（形式・enum 値を narrow）。Slash command は `options` を `zod` で narrow する。
   5. DB から Session を再取得し、`status` が現在の操作を受け付ける状態であること
3. 状態更新は **DB のトランザクション + 条件付き `UPDATE ... WHERE status = ...`**。`(sessionId, memberId)` unique 制約で response 競合を吸収。
4. **再描画は常に DB の Session + Response から組み立て**、`interaction.message.edit(...)` で更新する。追加通知が必要なときだけ `followUp()`。
5. 押下前のメッセージ内容や `custom_id` だけを信じない。最新状態は必ず DB から取り直す。

### Custom ID 設計
- 募集ボタン: `ask:{sessionId}:{choice}`（choice = `t2200` / `t2230` / `t2300` / `t2330` / `absent`）。
- 順延ボタン: `postpone:{sessionId}:{ok|ng}`。
- `custom_id` は**信頼せず**、`zod` で parse して型を narrow してから使う。

### Slash command 同期
- **Guild-scoped bulk overwrite** のみ（global 登録は使わない、伝播即時で運用事故が少ない）。
- deploy ごとに無条件で同期する（bulk overwrite は冪等）。

### Discord 最小権限の前提
- OAuth2 scopes: `bot` / `applications.commands` のみ。
- Gateway Intents: `Guilds` のみ（`GuildMessages` / `MessageContent` / `GuildMembers` は不要）。
- Bot Permissions: `View Channel` / `Send Messages` / `Embed Links` のみ。

### Discord API 失敗時の整合性
- DB 更新成功 → `interaction.message.edit(...)` 失敗のような片肺は **DB を正本** として扱い、次の cron tick で Session 状態から再描画を試行する。
- `messageId` が無効（削除済 / 権限変更）の場合は新規投稿し、Session の参照メッセージ識別子を更新する。
- 再試行には上限を設け、超過時はログに残して人間が確認する。

## Observed anti-patterns
- `deferUpdate()` を後回しにして 3 秒制約を超過する。
- `custom_id` や message payload を信用して DB 再取得を省略する。
- 対象外ユーザー・チャンネル・Guild の操作を黙って通す。
- Discord 表示状態を正本として扱い、DB 状態と乖離させる。
- `editMessage` 失敗を理由に DB 状態を巻き戻す（片肺でも DB を正本のまま、次 tick 再描画で回復）。
- slash command を global で登録し、伝播待ちで運用がズレる。

## Review checklist
- defer → 検証 → 状態変更 → 再描画 の順序が保たれているか。
- 検証失敗時に DB 状態を変えず、理由がログに残るか（ephemeral 応答あり）。
- 同時押下（4 名同時 / cron と同時）で冪等に振る舞うか。
- Guild-scoped 同期で slash command が deploy ごとに bulk overwrite されているか。
- 再描画が常に DB の Session + Response から組み立てられているか。
