---
adr: 0046
title: ユーザー向け設定ファイルと env / TypeScript 設定境界
status: accepted
date: 2026-04-25
supersedes: [0011, 0012, 0013]
superseded-by: null
tags: [runtime, ops, docs]
---

# ADR-0046: ユーザー向け設定ファイルと env / TypeScript 設定境界

## TL;DR

ユーザーが理解・編集する非 secret 設定は YAML の user config に置き、アプリ runtime は `SUMMIT_CONFIG_YAML` の YAML 本文だけを読む。TypeScript の `src/config.ts` は user config からの派生値と内部チューニング定数のみを持つ。

## Context

`src/config.ts` は cron・時刻・outbox など性質の異なる値を同居させ、`src/env.ts` は secrets と Discord 対象・member 情報を同じ平面で扱っていた。これにより、利用者が TypeScript を直接編集するか、secret と非 secret が混在した `.env.local` を編集する必要があった。

また README の env 表には実装と一致しない項目が残っており、AI / 人間のどちらにとっても「どこを変えればよいか」が読み取りにくくなっていた。ADR-0012 は member identity を env として扱い、ADR-0013 は runtime tunables を `src/config.ts` のコード定数に置く方針だったため、現在の要求と衝突する。

## Decision

設定境界を次の 3 層に分ける。

- **User config**: Discord guild / channel、固定 member の user ID と表示名、ユーザーに見えるスケジュール・slot、開発時 mention 抑止を YAML で管理する。runtime は `src/userConfig.ts` で YAML を `unknown` として読み、zod で起動時に fail-fast 検証する。
- **Environment variables**: Discord token、DB URL、healthcheck ping URL、Fly / CI metadata、`SUMMIT_CONFIG_YAML` に限定する。ローカルでは `package.json` scripts が `summit.config.yml` のファイル内容を `SUMMIT_CONFIG_YAML` に詰めてから起動する。
- **TypeScript internal config**: outbox worker、retention、metrics、reconnect debounce など、利用者が日常的に編集すべきでない信頼性チューニング値を保持する。cron 式など user config から安全に派生できる値は直接編集させない。

Member の identity は user config の `members[*].userId` を SSoT とし、DB `members.display_name` は boot reconcile で user config から同期する。削除は引き続き行わず、履歴保全のため DB に孤立 member 行が残ることを許容する。

## Consequences

### Follow-up obligations

- `.env.example` は secret / runtime env のみを示し、Discord 対象や member 設定は user config example へ移す。
- user config example はコメント付きで、各項目の意味・取得方法・変更リスクを近傍に書く。
- 設定値を ADR やコメントに重複記述しない。実行値は user config example / `src/userConfig.ts` / `src/config.ts` の責務に従う。
- 既存コードで `env.MEMBER_USER_IDS` や `env.DISCORD_CHANNEL_ID` を参照していた箇所は user config 参照へ移行する。

### Operational invariants & footguns

- user config に token / DB URL / ping URL を置かない。
- `summit.config.yml` はローカル実値を含み得るため Git 管理しない。コミットするのは example のみ。
- 本番で user config を注入する方法は deploy packaging と secrets 運用の両方に影響するため、Fly の設定手順を README に明記する。
- 固定 4 名、JST 固定、順延 1 回などの業務 invariant は zod schema で維持する。

## Alternatives considered

- **A: env に全設定を集約する** — secret と非 secret が混ざり、member ID と表示名の対応がカンマ区切り / positional coupling になって読みにくい。
- **B: TypeScript 設定ファイルを維持する** — 利用者にソース編集を要求し、設定ミスが型・ビルド・実行時責務と混ざる。
- **C: JSON 設定ファイル** — コメントを書けず、設定項目の意図・取得方法・AI 向け注意を近傍に置けない。
- **D: DB-only 設定** — 初回起動前に設定を投入する経路が必要になり、個人運用 Bot のセットアップを難しくする。

## Re-evaluation triggers

- member 数を固定 4 名から変更する要求が出たとき。
- Web UI や管理コマンドから設定変更する要求が出たとき。
- 複数 guild / 複数 channel 運用が必要になったとき。

## Links

- @see ADR-0012
- @see ADR-0013
- @see ADR-0011
- @see ADR-0022
