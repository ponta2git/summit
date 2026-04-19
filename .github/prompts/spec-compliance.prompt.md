---
mode: ask
description: "requirements/base.md と差分の仕様整合レビュー"
---

# Summit Spec Compliance Prompt

このリポジトリの差分を `requirements/base.md` の §1〜§16 と突き合わせてレビューしてください。  
特に以下を必ず検査し、該当箇所の **§番号を引用**して指摘してください。

## Required patterns
- 状態遷移が §9 と整合するか（終端状態・中間状態・遷移条件）。
- `custom_id` 形式とパース/検証順が仕様と一致するか。
- 締切ロジックが §3, §4, §14 と一致するか（21:30 判定、24:00 解釈など）。
- 順延ルールが §6 に一致するか（1回制限、土曜中止時の扱い）。
- ボタン仕様が §3.2 に一致するか。
- 開催確定条件が §4.2 に一致するか。

## Observed anti-patterns
- 仕様語彙の置換や独自用語の導入。
- 仕様未確定項目を推測で実装すること。
- 期限や候補日時の計算を ad-hoc に変えること。

## Review checklist
- 乖離があれば、差分箇所・根拠 §・修正案をセットで提示する。
- 仕様未確定がある場合は `TODO(ai): spec clarification needed - <理由>` の残置を提案する。
- 仕様変更が必要な場合は `requirements/base.md` 改訂の必要性を明示する。

## 参照
- `requirements/base.md`
- `AGENTS.md`
- `.github/instructions/runtime.instructions.md`
