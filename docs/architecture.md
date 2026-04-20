# Architecture Topology

summit（Discord Bot）の実装トポロジ。詳細根拠は `docs/adr/`、業務仕様は `requirements/base.md`。

## Feature 単位（`src/features/*`）
1 feature = 1 ディレクトリ。barrel は作らない（ADR-0025）。

| Feature | ディレクトリ | 責務 |
|---|---|---|
| ask-session | `features/ask-session/` | 金曜募集の投稿・ボタン・締切処理（§3, §4）|
| postpone-voting | `features/postpone-voting/` | 順延投票メッセージ・ボタン・締切処理（§6）|
| reminder | `features/reminder/` | 開始 15 分前の DM 相当リマインド送信（§5.2, ADR-0024）|
| decided-announcement | `features/decided-announcement/` | 開催決定時の別投稿（§5.1）|
| cancel-week | `features/cancel-week/` | `/cancel_week` 確認ダイアログと週単位 SKIPPED（§8, ADR-0023）|

## 共通 infra（`src/discord/shared/`）
- `dispatcher.ts`: interaction 入口（ack → guard → route）
- `guards.ts`: cheap-first 検証（guild / channel / user / custom_id）
- `customId.ts`: `custom_id` の zod codec
- `viewModels.ts`: pure な view model builder
- `messages.ts`: 共有 render helper（`getTextChannel` / `updateAskMessage` / `updatePostponeMessage`）

## feature 外（変更少）
- `src/time/`: JST / ISO week / 締切計算（ADR-0002）
- `src/db/`: Drizzle schema / repositories / client / **ports**（ADR-0003, ADR-0018, ADR-0026）
- `src/slot.ts`: wire format SSoT（SlotKey / customId choice / DB enum mapping, ADR-0013, ADR-0026）
- `src/scheduler/`: cron 登録（registry 方式）
- `src/members/`: 起動時 env→DB 同期
- `src/env.ts`, `src/config.ts`, `src/messages.ts`: SSoT（ADR-0022）

## 依存方向
```
features/* ──► discord/shared/ ──► db/ports ──► db/repositories, time/
          ╰────► slot.ts, messages.ts, env.ts, config.ts
scheduler/ ──► features/*.settle, features/*.send
index.ts ──► scheduler/, dispatcher
```
feature 相互依存は避ける。共通化が必要なら `discord/shared/` に抽出する（ADR-0025, ADR-0026）。
