---
applyTo: "src/commands/**/*.ts,src/**/*interaction*.ts"
---

# Interaction Review Rules

## Required patterns
- `interaction.deferUpdate()` を受信直後 3 秒以内に実行する。
- 検証順序は cheap-first を守る（`guildId` → `channelId` → `user.id ∈ MEMBER_USER_IDS` → `custom_id` の zod `safeParse` → DB から session 再取得）。
- 状態変更は DB 正本で行い、更新後の再描画は DB から再構築したデータのみを使う。
- slash command は guild-scoped で同期する。
- 対象外操作は状態変更せず ephemeral で却下する。
- 同時押下を前提に、条件付き `UPDATE` と unique 制約で競合を吸収する。

## Observed anti-patterns
- `deferUpdate()` を後回しにして 3 秒制約を超過する。
- `custom_id` や message payload を信用して DB 再取得を省略する。
- Discord 表示状態を正本として扱い、DB 状態と乖離させる。
- 対象外ユーザーの操作を黙って通す。

## Review checklist
- defer → 検証 → 状態変更 → 再描画の順序を守っているか。
- 検証失敗時に状態を変えず、理由がログに残るか。
- 競合時に冪等動作し、二重押下で壊れないか。
- ephemeral 応答と guild-scope 同期が維持されているか。

## 参照
- `requirements/base.md` §3.2, §4, §9, §13.2, §14
- `.github/instructions/runtime.instructions.md`
- `AGENTS.md`
