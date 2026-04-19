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

## Context
本 Bot は固定 4 名による短時間のボタン操作が集中しやすく、同時押下と cron 実行が同時に起きる。
Discord Interaction は受信後 3 秒以内に ack しないと失敗するため、重い検証や DB I/O を先に行う設計は破綻しやすい。
また、Component と Slash command では discord.js v14 の応答 API が異なり、誤用すると runtime error になる。
global command 登録は伝播遅延が最大 1 時間あり、デプロイ直後に旧定義が残ると運用事故につながる。
さらに、`message.edit` 失敗や message 消失は実運用で起こり得るため、表示状態を正本にすると復旧の基準が曖昧になる。
したがって、ack 戦略・検証順序・状態更新手順・コマンド同期方式を明示的に固定する必要がある。

## Decision
- Interaction の ack を以下で使い分ける。
  - Component（ボタン）: `interaction.deferUpdate()`
  - Slash command: `interaction.deferReply({ ephemeral: true })` または `interaction.reply(...)`
- 受信後 3 秒以内に必ず ack する。
  - ハンドラ入口で即 defer/reply を行い、その後に検証と状態更新を実施する。
- 検証順序は cheap-first を固定する。
  1. `interaction.guildId === env.DISCORD_GUILD_ID`
  2. `interaction.channelId === env.DISCORD_CHANNEL_ID`
  3. `interaction.user.id ∈ env.MEMBER_USER_IDS`
  4. Component は `custom_id` を `zod.safeParse`、Slash command は `options` を `zod` で narrow
  5. DB から Session を再取得し、現在 `status` が操作可能か確認
- 対象外・不正入力は状態変更せず、ephemeral で却下する。
- Component の custom_id 形式を次に固定する。
  - 募集ボタン: `ask:{sessionId}:{choice}`
  - `choice` は `t2200` / `t2230` / `t2300` / `t2330` / `absent`
  - 順延ボタン: `postpone:{sessionId}:{ok|ng}`
  - `custom_id` は信用せず、parse 成功後の値のみ利用する。
- 状態更新は DB transaction + 条件付き UPDATE で原子的に行う。
- 再描画内容は DB の Session + Response から再構築する。反映先となる Discord message の識別子（`channelId` / `messageId`）は Session 作成時に DB に保存しておき、interaction 経由なら `interaction.message.edit(...)`、cron など interaction 非依存の経路では保存済み識別子から `channels.fetch` → `messages.fetch` → `message.edit(...)` で反映する。
- Discord API 側の失敗（編集失敗、messageId 無効など）では DB を巻き戻さない。
  - DB を正本として維持し、次 cron tick または次 interaction で保存済み識別子から再描画を試行する。
- Slash command は Guild-scoped の bulk overwrite で同期する。
  - deploy ごとに `pnpm commands:sync` を無条件実行し、定義を冪等に上書きする。
  - global 登録は伝播遅延が長いため採用しない。
- Discord 権限は最小化する。
  - OAuth2 scopes: `bot` + `applications.commands`
  - Intents: `Guilds` のみ
  - Bot Permissions: `View Channel` / `Send Messages` / `Embed Links` のみ

## Consequences
- Positive
  - 3 秒制約違反による interaction failure を抑制できる。
  - cheap-first 検証で不要な DB アクセスを削減し、負荷と遅延を下げられる。
  - custom_id を zod で narrow することで、不正入力や壊れた payload の影響を局所化できる。
  - DB 正本を固定するため、表示更新失敗時も回復基準が明確になる。
  - Guild-scoped 同期により、deploy 後の command 反映が即時かつ予測可能になる。
  - 最小権限化で Bot 権限の過剰付与リスクを下げられる。
- Negative
  - 毎回の検証と再取得で実装が冗長になり、ハンドラの記述量が増える。
  - global command を使わないため、複数 Guild 展開時は同期設計を再検討する必要がある。
  - DB 正本方針により、表示崩れが一時的に残る場合がある（次 tick 回復前提）。
  - deploy ごとの bulk overwrite を運用手順に組み込む必要がある。
- Operational implications
  - ハンドラ実装レビューでは「ack -> 検証 -> DB 更新 -> 再描画」の順序を必須チェックにする。
  - `commands:sync` をデプロイパイプラインの固定ステップとして扱う。
  - Discord API 失敗時は DB 整合性を優先し、再試行ジョブで収束させる。

## Alternatives considered
- **Slash command を global 登録**
  - 却下理由: 伝播遅延とキャッシュにより旧定義が残り、デプロイ直後の挙動が不安定になる。
- **defer せず直接 reply のみで処理**
  - 却下理由: 検証や DB I/O が重なった際に 3 秒制約を超えやすく、失敗率が上がる。
- **Discord 表示状態を正本として扱う**
  - 却下理由: 編集失敗や message 消失時に状態の権威が失われ、再描画基準が曖昧になる。
- **Session 再取得を検証の最初に実行**
  - 却下理由: guild/channel/user で弾けるリクエストまで DB ラウンドトリップが発生し、コスト効率が悪い。
- **custom_id に JSON を埋め込む**
  - 却下理由: 文字数制限・可読性・検証容易性の観点で `:` 区切り固定フォーマットの方が運用しやすい。
