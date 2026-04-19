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

## Context
この Bot は個人開発で、対象は単一 Guild・単一チャンネル・固定 4 名に限定される。
運用の中心は週 1 回の出欠確認であり、業務システムのような多環境運用や大規模監視は要求されない。
一方で、本番は毎週決まった時間帯に確実に動く必要があり、誤 deploy、過剰権限、秘密情報漏洩の影響は小さくない。
開発速度を保ちながら、事故が起きやすい箇所だけを明確に制限する必要があった。
また、更新頻度の低い個人開発では、依存更新や監視を厳格にしすぎると運用コストだけが増えやすい。
そのため、環境数、deploy 可能時間、依存更新手順、CI に置く認証情報、Discord 権限、secret の置き場、死活監視の粒度を一つの方針として固定する。

## Decision
### Staging environment
- Staging 環境は作らない。
- 開発用 DB は Neon branch を使い、本番とは分離する。
- 検証はローカル実行と開発用 DB で行い、受け入れ後は本番へ直接反映する。

### Deployment window
- 金曜 17:30 から翌土曜 01:00 JST までは、アプリ deploy、再起動、schema 変更を禁止する。
- この時間帯は募集送信、締切判定、順延確認、土曜再募集の準備と重なるため、手動変更を入れない。
- 緊急時も原則として運用停止やロールバックを優先し、通常変更は次の安全時間帯まで待つ。

### Dependency updates
- 依存更新は Dependabot の週次提案を基本とする。
- `pnpm audit` は参考情報として扱い、CI の fail 条件にはしない。
- セキュリティ勧告が出た依存は、利用箇所と影響を確認したうえで、可能ならパッチリリースで早期更新する。

### Fly API token policy
- GitHub Actions には app-scoped deploy token だけを置く。
- 発行方法は deploy 専用 token を前提とし、Personal Auth Token は CI に保存しない。
- token 漏洩が疑われた場合は即時 revoke し、新 token を発行して差し替える。

### Discord permissions
- OAuth2 scopes は `bot` と `applications.commands` のみを使う。
- Gateway Intents は `Guilds` のみを有効にする。
- Bot Permissions は `View Channel`、`Send Messages`、`Embed Links` のみに絞る。
- 追加権限が必要になった場合は、個別の理由を明記して再判断する。

### Secrets management
- 本番 secret は Fly secrets に保存する。
- ローカル secret は `.env.local` に置き、Git 追跡対象から外す。
- commit してよい env ファイルは `.env.example` の雛形だけとする。
- Discord token、`DATABASE_URL`、`DIRECT_URL`、`HEALTHCHECK_PING_URL` の実値は、コード、ログ、PR、fixture に載せない。

### Health monitoring
- 死活監視は healthchecks.io を使う。
- 毎分の cron tick 成功時に ping を送る設計とする。
- `HEALTHCHECK_PING_URL` が未設定なら監視は no-op とし、未設定を理由にアプリ起動を止めない。

## Consequences
- Positive
  - 環境を増やさないため、個人開発でも設定差分や同期漏れを管理しやすい。
  - deploy 禁止窓により、最も重要な運用時間帯の事故率を下げられる。
  - Dependabot を基本にすることで、更新作業を十分小さく保てる。
  - CI には deploy 専用 token しか置かないため、漏洩時の影響範囲を限定できる。
  - Discord 権限を最小化することで、誤操作や侵害時の被害面積を抑えられる。
  - secret の保存場所と公開禁止範囲を固定することで、レビュー基準が明確になる。
  - healthchecks.io を任意オプションにすることで、無料枠で最低限の監視を確保しつつ、未設定でも開発を妨げない。
- Negative
  - staging がないため、本番相当の完全な事前検証はできない。
  - deploy 禁止窓中は、軽微な修正でも即時反映できない。
  - `pnpm audit` を参考扱いにするため、脆弱性対応の最終判断は人が行う必要がある。
  - 最小権限方針により、将来機能追加時には権限見直しの手間が発生する。
- Operational implications
  - main への反映前に、変更が禁止窓にかからないことを確認する。
  - CI secret の棚卸しでは、deploy token が app-scoped のみであることを定期確認する。
  - ログや PR テンプレートでも secret 実値を出さない運用を徹底する。

## Alternatives considered
- Staging 環境 + pre-prod smoke test
  - 環境差分の管理コストが大きく、固定 4 名の実運用確認は本番でしか成立しない。個人開発の規模に対して見返りが小さいため採用しなかった。
- Renovate の導入
  - 高度な自動化は可能だが、このプロジェクトの依存数と更新頻度では Dependabot で十分だった。運用ルールも単純に保てる。
- Personal Auth Token を CI に置く運用
  - 権限範囲が広すぎ、漏洩時の影響が大きい。deploy 専用 token で代替可能なため却下した。
- New Relic / Datadog などのフルマネージド監視
  - Bot の規模に対してコストも運用設計も過剰だった。毎分 ping の死活確認で必要十分と判断した。
