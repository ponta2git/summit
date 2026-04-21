# TS1 Findings

## Summary
- 判定: SUSPECT (実漏えい未検出、誤検知 + tracked backup あり)
- gitleaks: 2 (全期間) / 0 (HEAD)
- High 0 / Medium 0 / Low 2 (いずれも誤検知)

## gitleaks Results (redacted)
| commit | path | line | rule | 判定 |
|---|---|---|---|---|
| 15e8dac | tests/env/env.test.ts | 8 | discord-client-id | 誤検知 (dummy) |
| 15e8dac | tests/env/env.test.ts | 9 | discord-client-id | 誤検知 (dummy) |

## Tracked Backup
- requirements/base.md.original.bak: secret 0 件

## .gitignore 追加推奨
- *.swp, *.swo, *.bak, *.orig

## CI 自動化提案
- PR: diff-level gitleaks
- nightly: full-history
- `.gitleaksignore` で tests/env/env.test.ts の該当 rule を最小限定

## 残項目
- Fly/Neon rotation は TS6
