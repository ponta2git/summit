# AGENTS.md

Summit（固定4名の桃鉄1年勝負の出欠を自動化するDiscord Bot）でAIエージェントが安全に作業するための入口。詳細な設計はliving documentsが正本であり、本書へ重複させない。

## 1. 文書を選ぶ

最初に`docs/README.md`を読み、変更対象に必要な文書だけを選ぶ。全ドキュメントを一括で読まない。確認済みの文書はファイル名と要点を再利用する。

| タスク | 最初に読む |
|---|---|
| 業務仕様、状態、締切、順延、週キー | `requirements/base.md` |
| feature、依存方向、scheduler、runtime | `docs/architecture.md` |
| Interaction、custom ID、Discord表示 | `docs/discord-rule.md` |
| DB、transaction、outbox、migration | `docs/db-rule.md` |
| JST、deadline、ISO week、clock | `docs/time-rule.md` |
| test、fake、race、CI | `docs/test-rule.md` |
| command、toolchain、命名、comment、Git | `docs/dev-rule.md` |
| 障害、復旧、backup、rotation | `docs/operations/README.md` |
| 文書体系または設計判断の変更 | `docs/README.md` |

実行されるcron、HH:MM、閾値、state/columnの実体は`src/config.ts`、`src/env.ts`、`src/userConfig.ts`、`src/time/`、`../momo-db/src/schema.ts`を確認する。文書やcommentへ値を書き写さない。

## 2. 違反即停止

- Fly scale増、local二重起動、cron多重登録など単一instance前提を破らない。
- token、接続文字列、monitor URL、Authorization等の実値をcode、fixture、log、PR、commit、chatへ出さない。
- production DBへ手動`INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / `DROP`、`fly ssh`経由の生SQLを実行しない。
- migrationで`drizzle-kit push`を使わない。momo-dbでgenerate→SQL review→migrateの順に行う。
- `fly secrets unset`や既存secret上書きをad-hocに実行しない。
- 金17:30〜土01:00 JSTにdeploy、restart、schema変更を行わない。
- CommonJS `require()`を追加しない。ESMとNode native TypeScriptの前提を維持する。
- mise / `package.json`管理外のNode・pnpmでlocal commandを実行しない。
- 明示承認なしに`requirements/base.md`の業務用語、状態、締切、参加条件を変更しない。

## 3. 作業前の確認

1. 変更対象の正本文書を特定したか。
2. JST/週キー/deadlineに触るなら`src/time/`と`ctx.clock`を使うか。
3. handler/scheduler/orchestrationなら`ctx.ports.*`を使い、repositoryを直接importしていないか。
4. InteractionならDB/API処理より先にackするか。
5. DB writeならaggregate command、transaction、CAS、unique、raceを確認したか。
6. 外部へ新規投稿するなら、同期sendではなくtyped outbox intentが必要か。
7. env/secret/logへ触るならparse済み値とredact境界を維持するか。
8. production operationならdeploy禁止窓とrunbookを確認したか。

## 4. 仮定と停止protocol

```text
仕様に明記あり? ─ Yes → 正本に従う
        │
        No
        ├─ production破壊 / secret露出 / 禁止窓 / scale逸脱? ─ Yes → STOP
        ├─ 締切 / 週キー / 順延 / 参加条件 / 状態 / custom ID等の業務判断? ─ Yes
        │      → todo(ai): spec clarification needed - <issue> + ASK
        └─ 可逆で小さい技術判断 → PROCEEDし、仮定をPR本文へ記録
```

正本文書同士が矛盾する場合、codeを自動的に優先しない。情報種別ごとの正本と競合処理は`docs/README.md`に従う。

## 5. 実装境界

- handler、scheduler、orchestrationは`AppContext`を受け、DBは`ctx.ports.*`、時刻は`ctx.clock`から使う。
- business writeは`SessionCommandsPort`へ集約し、Response writeとstate transitionを別callで組み立てない。
- Discord messageはDB snapshotから再描画し、edit失敗でDBをrollbackしない。
- Componentは入口で`deferUpdate()`、slashは`deferReply()`または`reply()`してからguardする。
- custom ID、Discord payload、env由来入力は`unknown`からzod/codecでnarrowする。
- business errorはtyped state/result、boundary I/O errorは`AppError`と`ResultAsync`で表現する。repositoryやpure domainをblanket変換しない。
- feature間の副作用importを作らず、cross-feature flowは`src/orchestration/`に置く。
- testは`createTestAppContext`のfake portsを使い、repository moduleへの新規`vi.mock`を追加しない。
- race testはsleepでなく明示同期点、時刻testはfake clockを使う。

## 6. 設計変更protocol

番号付きの判断履歴文書を追加しない。現在の設計を変更するときは、対応するliving documentを同じPRで直接更新する。

必要に応じて次を書く。

- 採用する規則・不変条件
- 理由
- 現在も再提案されやすい非採用案
- 再評価条件
- code/config/testへのpointer

一時互換には観測可能な撤去条件を必ず持たせる。完了済み移行計画や年代順の追記をdocsへ蓄積せず、過去はGit/PR履歴で調査する。

## 7. 検証

通常の完了gate:

```bash
git diff --check
pnpm run ci
```

`pnpm ci`はpnpmのinstall系commandであり、品質gateではない。必ず`pnpm run ci`を使う。

DB/schema/migrationに触れた場合はmomo-dbのcheckとSummit integration test、Discord command定義を変えた場合はguild-scoped sync、運用変更では該当runbookも確認する。

baseline失敗がある場合は、再現方法、変更前からの失敗である証拠、自分の変更範囲で通した検証をPRへ記載する。

## 8. Local DB

週次flowをやり直すとき、`docker exec` / `psql`で手動TRUNCATEしない。

- `pnpm db:reset` — transient stateをresetしmemberを保持
- `pnpm db:reset --all` — memberもreset。後で`pnpm db:seed`必須

実体は`scripts/dev/reset.ts`で、非local hostなら停止する。このguardを迂回しない。

## 9. PRと完了条件

- commitは英語のConventional Commits。PR本文は日本語。
- PRに変更点、仮定、要確認事項、影響範囲、test、運用影響、risk、更新した設計文書を書く。
- 実装がrequirementsを満たし、主要なfailure/race/recovery caseをtestしている。
- code、test、requirements、設計文書が同じcontractを示す。
- secret、production破壊、deploy禁止窓、single-instance逸脱がない。
- `pnpm run ci`と必要なintegration/operation検証が通る。
