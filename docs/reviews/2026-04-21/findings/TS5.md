# TS5 Findings

## Summary
- 判定: Medium (High 1 / Medium 1 / Low 2)
- 直接的な注入・secret 漏えい経路は小、`permissions` 未明示 + action SHA 未固定が主リスク

## Workflow inventory
- `.github/workflows/ci.yml` のみ (他なし)
- triggers: push(master) / pull_request
- jobs: static-baseline / drift-check / integration-db
- secrets: **参照ゼロ** (FLY_API_TOKEN / DATABASE_URL / HEALTHCHECK_PING_URL 不使用)
- actions: checkout@v4, pnpm/action-setup@v4, setup-node@v4 (tag pin, SHA 未固定)
- runner: ubuntu-latest
- concurrency: 未設定

## Injection surface
- run: 内の `${{ github.* }}` / PR 本文 / ブランチ名展開なし (ci.yml:26-50,67-74,113-122)
- pull_request_target / workflow_run 未使用
- script: verify/forbidden-patterns.sh / migration-drift.sh に `eval`/`bash -c` なし、引用済

## Findings
### F1: permissions 未明示 [High]
- ci.yml に workflow/job 両レベルで `permissions:` なし
- GITHUB_TOKEN のデフォルト権限に依存 (repo 設定次第で write-all の可能性)
- 推奨: 先頭に `permissions: { contents: read }`、必要 job のみ最小追加

### F2: action が SHA 未固定 [Medium]
- checkout@v4 / setup-node@v4 / pnpm/action-setup@v4 全て tag pin
- 供給網改ざん耐性不足
- 推奨: commit SHA で固定 (Dependabot 対象にも)

### F3: ubuntu-latest 固定なし [Low]
- 将来イメージ更新で静かに挙動変わる
- 推奨: ubuntu-24.04 等固定

### F4: .github 設定面不在 [Low]
- dependabot.yml / codeql.yml 不在で依存監視・コードスキャン自動化なし

## Secret exposure
- secrets.* の action への受け渡しゼロ
- 追跡対象 env は `.env.example` のみ、プレースホルダ値のみ (例: DISCORD_TOKEN=replace-with-bot-token)
- 実値の git 含有なし (TS1 ともと整合)

## Unknown (範囲外)
- Branch protection / required checks
- fork 時 GITHUB_TOKEN 実効権限
- Copilot coding agent workflow (別経路)

## TS1 との整合
- TS1 で「実値未コミット」確認済、本 review で再確認
- TS1 F との重複は permissions 側のみ、本 task で上乗せ
