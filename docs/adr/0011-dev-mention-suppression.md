---
adr: 0011
title: 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS）
status: superseded
date: 2026-04-20
supersedes: []
superseded-by: 0046
tags: [discord, ops, runtime]
---

# ADR-0011: 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS）

## TL;DR
env flag `DEV_SUPPRESS_MENTIONS` を導入し、ON 時は (1) 送信本文から `<@id>` を条件付きで除去、(2) `Client` に `allowedMentions: { parse: [] }` を付ける、の二段構えで push 通知を抑止する。本番では未設定（= false）を invariant として維持する。

## Context
開発中はコード挙動確認のため本番チャンネルへ投稿したいが、固定 4 名への `<@userId>` による push 通知は迷惑になる。一方、本番運用ではメンション通知を飛ばすことが必須（固定 4 名の同期に依存）。

送信経路は 3 箇所（`src/discord/ask/render.ts` の `buildAskContent` / `src/discord/postponeMessage.ts` の `renderPostponeBody` / `src/discord/settle.ts` の cancel 送信）で `env.MEMBER_USER_IDS.map((id) => \`<@\${id}>\`).join(" ")` を content に埋め、`channel.send` / `msg.edit` 時は `allowedMentions` を指定しない（Discord 既定で content 中の `<@id>` が解析され push 通知）。

要件上の制約:

- 本番は既存挙動を一切変えない（未設定で従来通り）。
- 検証ロジック・DB 状態・custom_id・判定ロジックは不変（表示層・通知層のみに波及させる）。
- 単一インスタンス / DB 正本 / デプロイ禁止窓の invariant も不変。

## Decision
env flag `DEV_SUPPRESS_MENTIONS`（boolean, default `false`）を導入し、ON 時に次の**二段構え**で push 通知を抑止する。

### 抑止レイヤ
1. **本文除去（正本）**: 3 送信地点（`src/discord/ask/render.ts` / `src/discord/postponeMessage.ts` / `src/discord/settle.ts`）で `<@id>` 行を content 配列から**条件付き push で省く**。`filter(Boolean)` は意図した空行まで潰すため禁止。cancel 送信は `[mentions, cancel].filter((line) => line.length > 0).join("\n")` で先頭改行残存を防ぐ。
2. **Client-level の保険**: `createDiscordClient` で ON 時に `allowedMentions: { parse: [] }` を付与。将来の新規送信経路で `<@id>` 混入しても user / role / everyone いずれも通知しない。

### env parse
`HEALTHCHECK_PING_URL` と同流儀で `z.preprocess((v) => v === "" ? undefined : v, z.stringbool().default(false))`。**`z.coerce.boolean()` 禁止**（`"false"` / `"0"` が true になる）。

### Invariants
- **per-message `allowedMentions` を渡さない**。渡すと Client-level 設定が無効化される。回帰テストで担保。
- **本番 invariant**: Fly secrets に `DEV_SUPPRESS_MENTIONS` を設定しない（未設定 = false）。設定する場合も値は `false` のみ。
- **DB / 状態 / custom_id / 判定ロジックは不変**。本 flag は表示・通知層のみに影響。

### ログ
起動時 ON のときのみ `logger.warn` を 1 回（毎送信ログはノイズ）。

## Consequences

### Follow-up obligations
- 送信コード 3 箇所（`src/discord/ask/render.ts` / `src/discord/postponeMessage.ts` / `src/discord/settle.ts`）+ `createDiscordClient` + env スキーマ + テスト + ドキュメントを同時更新する。
- 回帰テスト: env の boolean parse、`createDiscordClient` の `client.options.allowedMentions` 分岐、3 render / send 地点で ON 時に `content` が `<@` 部分文字列を含まないこと、の assert を維持する。`vi.resetModules()` + `vi.stubEnv()` + dynamic import で env 依存モジュールを scenario 毎に切り替える。

### Operational invariants & footguns
- **本番 invariant**: 本番（Fly secrets）に `DEV_SUPPRESS_MENTIONS` を**設定しない**（未設定 = false）。設定する場合も値は `false` のみに限る。本番誤設定で本番メンションが停止する footgun。
- **per-message `allowedMentions` を指定しない**: 3 送信地点のいずれでも message 単位で渡すと Client-level 設定が無効化される。回帰テストで担保。
- **正本は B（本文除去）、A（`allowedMentions: { parse: [] }`）は保険**の二段構え。どちらか片方が破られても push 通知は飛ばない設計を維持する。
- `filter(Boolean)` で空行を潰さない（意図した改行構造まで壊す）。条件付き push or `filter((line) => line.length > 0)` を使う。
- **DB / 状態 / custom_id / 判定ロジックは不変**。本 flag を通知・表示層以外に波及させない。
- 開発時は display name が member status lines に残ることで送信対象を補完する（本文 mention 行は消える）。ログ化する場合はこの前提で組み立てる。

## Alternatives considered

- **A: Client-only（本文 `<@id>` を残す）** — push 通知は抑止できるが UI 上 `@username` が残り「表示上も消したい」要件に合わない。
- **B 単独: 本文除去のみ（Client 無変更）** — 将来追加される送信経路（reminder / admin 通知等）で `<@id>` 混入時の安全弁が無く、A との belt-and-suspenders に劣る。
- **C: Hybrid（常時 `parse: []` + per-message opt-in）** — 3 送信地点固定の現規模では複雑性に見合わず、invariant 逆転を伴う本番挙動変更が過剰。事故顕在化時に再検討。
- **display name 置換（`<@id>` を `@いーゆー` に差替）** — 本文「回答状況」で既に display name が出ており、上部 mention 行を残す意味が薄い。
