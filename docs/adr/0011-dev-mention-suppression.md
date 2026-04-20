---
adr: 0011
title: 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS）
status: accepted
date: 2026-04-20
supersedes: []
superseded-by: null
tags: [discord, ops, runtime]
---

# ADR-0011: 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS）

## Context
summit は本番 Discord サーバの単一チャンネルに対し、固定 4 名へのメンション付きメッセージ（ask / postpone / cancel の 3 経路）を送信する。

開発中はコードの挙動確認のために本番チャンネルへ投稿したいが、`<@userId>` による push 通知がメンバーに飛ぶとそれ自体が迷惑となる。一方で本番運用では従来どおりメンションで通知を飛ばすことが必須（固定 4 名の同期に依存）。

現状のコードは 3 箇所（`src/discord/ask/render.ts` の `buildAskContent`、`src/discord/postponeMessage.ts` の `renderPostponeBody`、`src/discord/settle.ts` の cancel 送信）で `env.MEMBER_USER_IDS.map((id) => \`<@\${id}>\`).join(" ")` を本文に含め、`channel.send` / `msg.edit` 時は `allowedMentions` を指定しない（Discord 既定で content 中の `<@id>` をそのまま解析 → push 通知）。

要件:
- 開発時はメンション通知を飛ばさない（可能なら本文からメンション表示自体を消す）。
- 本番は既存挙動を一切変えない（未設定で従来通り）。
- 検証ロジック・DB 状態・custom_id・判定ロジックは変えない（表示層・通知層のみ）。
- Fly 単一インスタンス前提・DB 正本・デプロイ禁止窓等の既存 invariant は不変。

## Decision
env フラグ `DEV_SUPPRESS_MENTIONS`（boolean, default `false`）を導入し、ON 時に次の 2 段構えで mention を抑止する。

1. **本文除去（正本）**: 3 つの render / send 地点で `<@id>` を含む mention 行を本文（`content` 配列）から**条件付きで省く**（`filter(Boolean)` は意図した空行まで潰すため、条件付き push で組み立てる）。`settle.ts` の cancel 送信は `[mentions, cancel].filter((line) => line.length > 0).join("\n")` で先頭改行の残存を防ぐ。
2. **Client-level の保険**: `createDiscordClient` で ON 時に `new Client({ intents: [Guilds], allowedMentions: { parse: [] } })` を渡し、万一将来の送信経路で `<@id>` が本文に混入しても user / role / everyone いずれも push 通知を飛ばさない構造にする。

env は既存の `HEALTHCHECK_PING_URL` と同じ流儀で `z.preprocess((v) => v === "" ? undefined : v, z.stringbool().default(false))` を用いて parse する（`z.coerce.boolean()` は `"false"` / `"0"` が true になるため使わない）。

起動時に ON のときのみ `logger.warn({ devMentionSuppression: true, mentionSuppression: "client-default" }, "...")` を 1 回出す（毎送信ログはノイズ）。

## Consequences

### 得られるもの
- 開発中も本番チャンネルを使いながら、メンバーへの push 通知を避けられる。
- 本文からメンション文字列自体を除去するため、受信側にとって「通知は来ないが開発 bot が動いた」ことが明示的にわかる。
- Client-level の `allowedMentions: { parse: [] }` が将来の追加送信経路に対しても保険として効く（accidental mention 事故の防止）。

### 失うもの / 制約
- 送信コード 3 箇所 + Client 設定 + env スキーマ + テスト + ドキュメントの同時更新が必要になる。
- `DEV_` prefix を持つが env 変数である以上、本番で誤設定されれば本番メンションも停止する。本番 invariant として「未設定（= false）を常時維持」を運用で守る必要がある。
- 本文から mention が消えた開発メッセージは、将来ログ化された際に送信対象の示唆が弱くなる（member status lines には display name が残るため部分的に補完）。

### 運用上の含意
- **本番 invariant**: 本番（Fly secrets）に `DEV_SUPPRESS_MENTIONS` を**設定しない**（未設定 = false）。仮に設定する場合は値を `false` のみに限る。
- **正本は B（本文除去）、A（`allowedMentions: { parse: [] }`）は保険**。どちらか片方が破られても push 通知は飛ばない二段構え。
- **per-message `allowedMentions` を指定しない**。3 送信地点のいずれでも `allowedMentions` を message 単位で渡さないことを回帰テストで担保する（渡すと Client-level 設定が無効化されるため）。
- **DB / 状態 / custom_id / 判定ロジックは不変**。`DEV_SUPPRESS_MENTIONS` は通知・表示層のみに影響する。
- **テスト**: env の boolean parse、`createDiscordClient` の `client.options.allowedMentions` 分岐、3 render / send 地点で ON 時に `content` が `<@` 部分文字列を 1 つも含まないことを assert。`vi.resetModules()` + `vi.stubEnv()` + dynamic import で env 依存モジュールを scenario 毎に切り替える。

## Alternatives considered

### A 案（Client-only、本文 `<@id>` を残す）
`Client` に `allowedMentions: { parse: [] }` を付けるだけの最小変更。本文 `<@id>` は残るため Discord UI 上は `@username` として表示されるが、push 通知は飛ばない。
- 却下理由: 表示上も mention を消したい要件（開発中の視認性）に合わない。本文変更不要で最小変更だが、ユーザ要望と合致しない。

### B 案単独（本文除去のみ、Client 無変更）
3 render 地点のみ変更。Client 側は触らない。
- 却下理由: 将来の追加送信経路（reminder / admin notification 等）で `<@id>` が混入した場合の安全弁が無い。belt-and-suspenders の A を併用することで構造的に事故を防ぐ。

### C 案（Hybrid; 常時 `parse: []` + per-message opt-in）
Client は常に `allowedMentions: { parse: [] }`、通知したい場面でのみ per-message で `{ users: env.MEMBER_USER_IDS }` を opt-in。
- 却下理由: 現在 3 送信地点固定で複雑性に見合うメリットが薄い。全 send 地点に明示的 `allowedMentions` を付けるリファクタ範囲が広く、本番挙動を変更する（invariant を逆転）ため過剰設計。accidental mention 事故が顕在化したタイミングで再検討する。

### display name 置換（本文から `<@id>` を `@いーゆー` 等に差し替え）
- 却下理由: 本文の「回答状況」セクションで既に display name が表示されているため、上部 mention 行を残す意味が薄い。行ごと削除のほうが開発時のノイズが小さい。
