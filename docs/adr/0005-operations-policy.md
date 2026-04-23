---
adr: 0005
title: 運用ポリシー（Staging 不採用・禁止窓・依存更新・最小権限）
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [ops]
---

# ADR-0005: 運用ポリシー（Staging 不採用・禁止窓・依存更新・最小権限）

## TL;DR
個人開発規模に合わせ、Staging 環境は持たず、deploy 禁止窓（金 17:30〜土 01:00 JST）・Fly deploy-scoped token・最小 Discord 権限・Fly secrets + `.env.local` の secret 分離・healthchecks.io の任意 ping を運用ポリシーとして固定する。

## Context
個人開発規模と週次クリティカル運用の両立を図る運用ポリシーの決定。

Forces:
- 個人開発で多環境運用・大規模監視は過剰だが、毎週決まった時間帯に確実に動く必要があり、誤 deploy・過剰権限・secret 漏洩の影響は小さくない。
- 更新頻度が低いため、依存更新・監視を厳格化しすぎると運用コストだけが膨らむ。
- 開発速度を保ちつつ、事故が起きやすい箇所（deploy タイミング・CI token 権限・secret の置き場・Discord 権限）だけを明確に制限したい。

## Decision

### Staging environment
- Staging 環境は**作らない**。開発用 DB は Neon branch で本番と分離する。受け入れ後は本番へ直接反映する。

### Deployment window
- **金 17:30〜土 01:00 JST は deploy / 再起動 / schema 変更を禁止**。募集送信・締切判定・順延確認と重なる時間帯に手動変更を入れない。
- 緊急時も原則として運用停止・ロールバックを優先し、通常変更は次の安全時間帯まで待つ。

### Dependency updates
- Dependabot の週次提案を基本とする。`pnpm audit` は参考情報で CI の fail 条件にしない。
- セキュリティ勧告時は影響確認のうえ早期パッチ更新する。

### Fly API token policy
- GitHub Actions には **app-scoped deploy token のみ**を置く（`fly tokens create deploy`）。Personal Auth Token を CI に保存**しない**。
- 漏洩疑い時は即 revoke し新 token で差し替える。

### Discord permissions
- 最小権限の具体値は ADR-0004 と `.github/instructions/interaction-review.instructions.md` を参照（`bot` + `applications.commands` / Intents `Guilds` のみ / `View Channel` + `Send Messages` + `Embed Links`）。
- 追加権限が必要な際は個別に理由を明記して再判断する。

### Secrets management
- 本番 secret は **Fly secrets のみ**。ローカルは `.env.local`（Git 追跡外）。commit 可能な env は `.env.example` 雛形のみ。
- 秘匿値の具体名は `src/env.ts` / `.github/instructions/secrets-review.instructions.md` を参照。実値をコード・ログ・PR・fixture に載せない。
- `fly secrets unset` / 既存 secret 上書きは**不可逆変更**。ad-hoc 実行禁止（事前通知 + 停止窓外 + 手順書でのみ）。

### Health monitoring
- healthchecks.io を使う。毎分の cron tick 成功時に ping 送信。
- `HEALTHCHECK_PING_URL` **未設定時は no-op**。未設定を理由にアプリ起動を止めない。
## Consequences

### Follow-up obligations
- 機能追加で Discord 権限 / Intents の拡張が必要になったら理由を明記し再判断する（最小権限ベースラインを崩さない）。
- CI の Fly token が app-scoped deploy token のみであることを定期棚卸しする。

### Operational invariants & footguns
- **Hard invariant**: 金 17:30〜土 01:00 JST は deploy / 再起動 / schema 変更を提案・実行しない（緊急でもロールバック優先）。
- **Hard invariant**: 本番 secret は Fly secrets のみ。commit 可能な env は `.env.example` の雛形のみ。`.env*` 実値・token・接続文字列をコード・fixture・ログ・PR に載せない。
- **Hard invariant**: `fly secrets unset` / 既存 secret 上書きは不可逆。事前通知 + 停止窓外 + 手順書でのみ実施。ad-hoc 実行禁止。
- **Hard invariant**: CI には Personal Auth Token を置かない。`fly tokens create deploy` の app-scoped token のみ。漏洩疑いは即 revoke。
- **Footgun**: `HEALTHCHECK_PING_URL` 未設定を理由にアプリ起動を止めない（未設定時は ping no-op）。

## Alternatives considered

- **Staging 環境 + pre-prod smoke test** — 環境差分の管理コストが大きく、固定 4 名の実運用確認は本番でしか成立しない。
- **Renovate の導入** — 依存数と更新頻度に対し Dependabot で十分で運用ルールも単純に保てる。
- **Personal Auth Token を CI に置く運用** — 権限範囲が広すぎ漏洩時の影響が大きく、deploy 専用 token で代替可能。
- **New Relic / Datadog 等のフルマネージド監視** — Bot の規模に対しコスト・運用設計が過剰で毎分 ping で必要十分。
