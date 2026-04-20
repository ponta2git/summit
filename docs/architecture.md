# Architecture Topology

summit（Discord Bot）の実装トポロジ。詳細根拠は `docs/adr/`、業務仕様は `requirements/base.md`。

## Feature 単位（`src/features/*`）
1 feature = 1 ディレクトリ。barrel は作らない（ADR-0025）。UI cosmetic 定数・ユーザー可視メッセージ・feature 固有の message editor はすべて feature 内に同居する（ADR-0027）。

| Feature | ディレクトリ | 責務 |
|---|---|---|
| ask-session | `features/ask-session/` | 金曜募集の投稿・ボタン・締切処理（§3, §4）|
| postpone-voting | `features/postpone-voting/` | 順延投票メッセージ・ボタン・締切処理（§6）|
| reminder | `features/reminder/` | 開始 15 分前の DM 相当リマインド送信（§5.2, ADR-0024）|
| decided-announcement | `features/decided-announcement/` | 開催決定時の別投稿（§5.1）|
| cancel-week | `features/cancel-week/` | `/cancel_week` 確認ダイアログと週単位 SKIPPED（§8, ADR-0023）|
| interaction-reject | `features/interaction-reject/` | interaction 拒否時のユーザー可視文言（reject / unknownCommand / staleButton / internalError）|

各 feature は原則 `messages.ts`（user-visible 文言）と `viewModel.ts`（DB 行 → UI VM の pure builder）を持ち、ask-session / postpone-voting は `constants.ts`（UI cosmetic）と `messageEditor.ts`（既存メッセージ再描画）を追加で持つ。ask-session は `cancelReason.ts`（週キャンセル理由語彙）も持つ（ADR-0028）。

## 共通 infra（`src/discord/shared/`）
interaction 入口 / 出口 / DB decouple 契約のみ。feature 固有のものは置かない（ADR-0027, ADR-0028）。
- `dispatcher.ts`: interaction 入口（ack → guard → route）
- `guards.ts`: cheap-first 検証（guild / channel / user / custom_id）
- `customId.ts`: `custom_id` の zod codec
- `channels.ts`: `getTextChannel`（Discord SDK 薄ラッパ）
- `viewModelInputs.ts`: `ViewModelMemberInput` / `ViewModelResponseInput` / `ViewModelSessionInput`（DB 行と UI builder を decouple する契約）

## feature 外（変更少）
- `src/time/`: JST / ISO week / 締切計算（ADR-0002）
- `src/db/`: Drizzle schema / repositories / client / **ports** / `rows.ts`（Row 型集約）（ADR-0003, ADR-0018, ADR-0026, ADR-0029）
- `src/slot.ts`: スロット値の domain + wire-format SSoT（domain / customId wire / DB wire の 3 section に整理, ADR-0013, ADR-0026, ADR-0029）
- `src/appContext.ts`: `AppContext` 定義 + composition root factory（ADR-0018, ADR-0029）
- `src/scheduler/`: cron 登録（registry 方式）
- `src/members/`: 起動時 env→DB 同期（`inputs.ts` / `reconcile.ts`）
- `src/env.ts`, `src/config.ts`, `src/logger.ts`: SSoT（ADR-0022）

## 開発用スクリプト（`scripts/`）
runtime ではないツール群。`src/` には置かない（ADR-0029）。
- `scripts/dev/seed.ts`: 初期 member 投入（`pnpm db:seed`）
- `scripts/dev/reset.ts`: localhost 限定の TRUNCATE（`pnpm db:reset`）
- `scripts/dev/scenario.ts`: 週フローのシナリオ実行（`pnpm dev:scenario`）
- `scripts/verify/*`: CI 補助

## 依存方向
```
features/* ──► discord/shared/{dispatcher,guards,customId,channels,viewModelInputs}
          ╰──► db/ports ──► db/repositories, time/
          ╰──► slot.ts, env.ts, config.ts, logger.ts, appContext.ts
scheduler/ ──► features/*.settle, features/*.send
index.ts ──► scheduler/, dispatcher, appContext
```
feature 相互依存は避ける。共通化が必要なら `discord/shared/` に抽出する（ADR-0025, ADR-0026, ADR-0027）。
