# Security Second Opinion (gpt-5.4)

## 追加/補強観点
1. Secret footprint の "tracked外" 監査 (.swp/.bak/.orig など、`requirements/base.md.original.bak` が tracked)
2. Secret の full-history 監査 (gitleaks 推奨、trufflehog は任意)
3. CI の shell-security gap (`${var@P}` `${!var}` `eval` 系パターン未検査)
4. GitHub Actions の `permissions:` 最小化
5. Fly token scope / SSH/root / Neon role rotation の運用監査

## 優先度
- High: Secrets footprint (tracked+history), Interaction trust & logging, DB/state integrity
- Medium: CI hardening, Ops credential hygiene, Supply chain
- Low: HMAC 再評価, Webhook inventory, dist/placeholder

## 最終 10 観点
1. Secrets footprint & history (gpt-5.3-codex + gitleaks, High)
2. Logging & telemetry redaction (gpt-5.3-codex, High)
3. Interaction trust boundary (gpt-5.3-codex, High)
4. DB & state integrity (gpt-5.3-codex, High)
5. Env/config fail-fast (gpt-5.4-mini, Medium)
6. Supply chain & lockfile hygiene (gpt-5.4-mini, Medium)
7. CI/workflow hardening (gpt-5.3-codex, Medium)
8. Shell / AI-assist guardrails (gpt-5.3-codex, Medium)
9. Ops credential hygiene (human + gpt-5.4-mini, Medium)
10. HMAC/webhook/dist/placeholders 再評価 (gpt-5.4-mini, Low)

## タスク分解 5 categories
A. Secret footprint audit / B. Interaction trust & logging / C. DB/state integrity / D. Supply chain & CI / E. Ops credential hygiene
