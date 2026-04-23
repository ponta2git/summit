---
adr: 0004
title: Discord Interaction ハンドリングと Slash Command 同期
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [discord, runtime]
---

# ADR-0004: Discord Interaction ハンドリングと Slash Command 同期

## TL;DR
Interaction は入口で即 ack（Component: `deferUpdate`、Slash: `deferReply`）→ cheap-first 検証（guild/channel/user → zod → DB）→ transaction で条件付き UPDATE → DB から再描画、の順に固定。Slash command は guild-scoped bulk overwrite のみで同期する（global 禁止）。

## Context
Interaction ハンドリングと slash command 同期方式の決定。

Forces:
- Discord Interaction は受信後 3 秒以内に ack しないと失敗する。検証や DB I/O を先に置く設計は破綻する。
- 固定 4 名のボタン操作は短時間に集中し、同時押下と cron 実行が重なる。
- discord.js v14 では Component（`deferUpdate`）と Slash（`deferReply` / `reply`）で応答 API が異なり、取り違えは runtime error。
- Global slash command 登録は伝播遅延最大 1 時間で、デプロイ直後に旧定義が残り運用事故になる。
- `message.edit` 失敗や message 消失は実運用で発生するため、表示状態を正本にすると復旧基準が曖昧になる。

## Decision

### Ack strategy
- 受信後 **3 秒以内に必ず ack**。ハンドラ入口で即 defer/reply し、検証・状態更新はその後に実施する。
  - Component（ボタン）: `interaction.deferUpdate()`
  - Slash command: `interaction.deferReply({ ephemeral: true })` または `interaction.reply(...)`

### Validation order (cheap-first)
1. `interaction.guildId === env.DISCORD_GUILD_ID`
2. `interaction.channelId === env.DISCORD_CHANNEL_ID`
3. `interaction.user.id ∈ env.MEMBER_USER_IDS`
4. Component は `custom_id` を `zod.safeParse`、Slash command は `options` を zod で narrow
5. DB から Session 再取得し現在 `status` が操作可能か確認

対象外・不正入力は状態変更せず ephemeral で却下する。早期弾きで DB ラウンドトリップを削減する。

### Custom ID format
- 募集ボタン: `ask:{sessionId}:{choice}`（`choice` ∈ `t2200` / `t2230` / `t2300` / `t2330` / `absent`）
- 順延ボタン: `postpone:{sessionId}:{ok|ng}`
- `custom_id` 値は信用しない。parse 成功後の narrow 済み値のみ利用する。

### State update & re-render
- 状態更新は DB transaction + 条件付き UPDATE で原子的に行う。
- 再描画内容は**常に DB の Session + Response から再構築**する。反映先 message の `channelId` / `messageId` は Session 作成時に DB 保存しておき、interaction 経路は `interaction.message.edit(...)`、cron など非 interaction 経路は保存済み識別子から `channels.fetch` → `messages.fetch` → `message.edit(...)` で反映する。

### Error handling
- Discord API 失敗（編集失敗 / 無効な messageId 等）で **DB を巻き戻さない**。DB 正本を維持し、次 cron tick または次 interaction で再描画を再試行する。再試行に上限を設けログに残す。
- `messageId` 無効時は新規投稿し、Session の参照 ID を更新する。

### Slash command sync
- **Guild-scoped の bulk overwrite のみ**。global 登録は伝播遅延（最大 1 時間）のため**禁止**。
- Deploy ごとに `pnpm commands:sync` を無条件実行し冪等に上書きする。

### Minimum permissions
- OAuth2 scopes: `bot` + `applications.commands`
- Gateway Intents: `Guilds` のみ
- Bot Permissions: `View Channel` / `Send Messages` / `Embed Links` のみ
## Consequences

### Follow-up obligations
- `pnpm commands:sync` をデプロイパイプラインの固定ステップとして維持する（bulk overwrite は冪等）。
- 複数 Guild 展開が必要になったら同期方式を再設計する（現状は guild-scoped 前提）。

### Operational invariants & footguns
- **Hard invariant**: Interaction は「入口で ack → 検証 → DB 更新 → DB から再描画」の順。defer より先に検証や DB I/O を入れると 3 秒制約違反になる。
- **Hard invariant**: Component は `deferUpdate()`、Slash は `deferReply()` / `reply()`。取り違えると runtime error。
- **Hard invariant**: Slash command は guild-scoped bulk overwrite のみ。global 登録は伝播最大 1 時間で旧定義が残り事故源になる。
- **Footgun**: `custom_id` の生値を信用しない。zod `safeParse` で narrow してから使う（choice / ok|ng の値まで含め全て検証）。
- **Footgun**: `interaction.message` の内容や押下前表示から状態を推測しない。最新は必ず DB から再取得する。
- **Footgun**: `message.edit` や `messageId` 無効で DB を巻き戻さない。次 tick / 次 interaction での再描画で収束させ、再試行上限超過はログに残す。`messageId` 無効時のみ新規投稿して Session の参照 ID を更新する。
- **Footgun**: Session 再取得を検証列の先頭に置かない。guild/channel/user/custom_id で弾ける入力にまで DB ラウンドトリップが発生する（cheap-first 順序を逆転させない）。

## Alternatives considered

- **Slash command の global 登録** — 伝播遅延とキャッシュで旧定義が残りデプロイ直後の挙動が不安定になる。
- **defer せず直接 reply で処理** — 検証や DB I/O が重なると 3 秒制約を超えやすく失敗率が上がる。
- **Discord 表示状態を正本として扱う** — 編集失敗や message 消失時に状態の権威が失われ再描画基準が曖昧になる。
- **Session 再取得を検証の最初に実行** — guild/channel/user で弾けるリクエストにまで DB ラウンドトリップが発生する。
- **custom_id に JSON を埋め込む** — 文字数制限・可読性・検証容易性で `:` 区切り固定フォーマットに劣る。
