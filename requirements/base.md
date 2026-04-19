# ゲームの出欠をとるアプリケーション 要求仕様

毎週金曜深夜に開催する「桃鉄1年勝負」の出欠を、Discord Bot を用いて自動化するアプリケーション。

> 原文の要求（概要）  
> 毎週開催している深夜の桃鉄1年勝負の出欠をとりたい。Discord 上で固定4名の出欠をとり、全員出席なら開催、誰か欠席 / 22時前に未返答があれば中止し、翌日順延の可否を確認する。

---

## 1. 概要

- **対象イベント**: 毎週金曜日深夜の桃鉄1年勝負
- **対象メンバー（固定4名）**:
  - いーゆー (`e.u_ddr`)
  - おーたか (`o_taka1986`)
  - あかねまみ (`akanema3`)
  - ぽんた (`ponta2d`)
- **基準タイムゾーン**: JST (Asia/Tokyo)。すべての時刻表記は特記無き限り JST。
- **運用チャンネル**: 専用チャンネル（例: `#桃鉄出欠`）。Bot のすべての投稿・インタラクションはこのチャンネルに限定。
- **固定4名以外の操作**: 無視する（コマンド実行・ボタン押下ともに）。

---

## 2. 全体フロー

```
[金曜 18:00] 自動で出欠確認メッセージを送信（/ask でも手動起動可）
        │
        │ 4名が5ボタン [22:00][22:30][23:00][23:30][欠席] のいずれかを押す
        │ ※ 締切 21:30 までは回答変更可能
        │
        ├─ 誰かが [欠席] を押下 ─────────→ 即時中止 ─→ 順延確認フローへ
        │
        ├─ 締切 21:30 時点で未回答者あり ──→ 中止確定 ─→ 順延確認フローへ
        │
        └─ 締切 21:30 時点で 4名全員が時刻選択 ─→ 開催確定フローへ
```

---

## 3. 出欠確認（募集）フェーズ

### 3.1 送信タイミング
- **自動送信**: 毎週金曜 **18:00 JST**（開催候補日当日の夕刻）
  - 順延中は、順延先の当日（土曜）**18:00 JST** に送信
- **手動送信**: スラッシュコマンド `/ask`
  - 実行権限: 固定4名のみ
  - **制約**:
    - 同一週内に `active` な募集がある場合は「既に募集中です」と ephemeral で返し、**新規募集は作成しない**
    - 順延確認フェーズ中は実行不可
    - **21:30 以降は新規募集を作成しない**（当日分はもう間に合わないため）

### 3.2 募集メッセージ構成
- **メンション**: 固定4名全員
- **本文**（例）:
  ```
  🎲 今週の桃鉄1年勝負の出欠確認です

  開催候補日: 2026-04-24(金) 22:00 以降
  回答締切:   21:30（未回答者が残っていれば中止）
  ルール:     「欠席」が1人でも出た時点で中止 / 押した時刻 "以降" なら参加OK
              （例: 23:00 を押すと 23:00/23:30 でも参加可能として集計されます）

  【回答状況】
  - いーゆー    : 未回答
  - おーたか    : 未回答
  - あかねまみ  : 未回答
  - ぽんた      : 未回答
  ```
- **ボタン（横1列・5個）**: `22:00` / `22:30` / `23:00` / `23:30` / `欠席`

### 3.3 回答挙動
- 4名それぞれが5ボタンのいずれか1つを押して回答。
- 回答は **募集メッセージ本文を編集して全員に可視化**する（各メンバーの選択 or 「未回答」）。
- **回答の変更**: 締切（21:30）までは自由に押し直し可能。最後に押したボタンを有効とする。
- **中止確定後**（欠席押下 or 締切未回答）は全ボタンを無効化し、以降の変更は不可。

---

## 4. 判定ロジック

### 4.1 中止確定（以下のいずれかで中止確定）
| 条件 | 発動タイミング |
|---|---|
| 誰か1人が `欠席` を押下 | 押された瞬間に即時 |
| 締切（金 21:30）時点で未回答者が1人以上残存 | 締切到達時 |

中止確定後は Section 6 の順延確認フローへ遷移。

### 4.2 開催確定
- **締切（21:30）時点で 4名全員が時刻ボタンを選択している**ことが条件。
- **集計ルール（「それ以降参加可能」解釈）**:
  - 各ボタンの意味: 「その時刻以降に参加可能」
  - 22:00 選択者は 22:00 / 22:30 / 23:00 / 23:30 すべてで参加可能
  - 23:00 選択者は 23:00 / 23:30 のみ参加可能
  - **開始時刻 = 4名の選択時刻のうち最遅のもの**（= 全員が参加可能な最早時刻）
- タイブレーク不要（開始時刻は常に一意に確定する）。
- 締切前に全員が時刻選択を終えていても、開催確定は **締切時点** で行う（それまでは暫定表示）。

### 4.3 暫定状態の表示
全員が時刻選択済みだが締切未到達の間は、募集メッセージの末尾に暫定開始時刻を表示：
```
暫定開始時刻: 23:00（21:30 の締切で確定）
```

---

## 5. 開催確定フェーズ

### 5.1 開催決定メッセージ
- **送信タイミング**: 締切（21:30）到達時、4名全員が時刻選択済みだった場合に即時投稿
- **メンション**: 参加者（＝ 4名）
- **本文**（例）:
  ```
  🎉 今週の桃鉄1年勝負は開催します！

  開始時刻: 23:00
  回答内訳:
  - いーゆー    : 22:30
  - おーたか    : 23:00
  - あかねまみ  : 22:00
  - ぽんた      : 22:30
  ```

### 5.2 15分前リマインド
- **送信タイミング**: 開始時刻の15分前（厳密にはリマインド予定時刻を含む処理周期内で送信。毎分ポーリング）
- **メンション**: 参加者（＝ 4名）
- **本文**（例）:
  ```
  ⏰ 15分後に開始です（23:00 開始）
  ```
- **取りこぼし対策**: 開催確定からリマインド予定時刻まで10分未満の場合、**リマインドは送らない**（直前メッセージとなり冗長のため）。

---

## 6. 中止・順延フェーズ

### 6.1 中止メッセージ
- **送信タイミング**: 中止確定の瞬間
- **メンション**: 固定4名全員
- **本文**（例）:
  - 欠席による中止:
    ```
    ❌ 今週の桃鉄1年勝負は中止です
    理由: おーたか さんが欠席を選択したため
    続けて、明日への順延確認を行います。
    ```
  - 未回答による中止:
    ```
    ❌ 今週の桃鉄1年勝負は中止です
    理由: 21:30 の締切時点で未回答者がいたため（未回答: いーゆー / あかねまみ）
    続けて、明日への順延確認を行います。
    ```

### 6.2 順延確認メッセージ
- **送信タイミング**: **金曜日の中止時のみ**、中止メッセージの直後に別メッセージで送信
  - **土曜日（順延先）の中止時は順延確認を行わない**（Section 6.3）
- **メンション**: 固定4名全員
- **本文**（例）:
  ```
  📅 明日（土曜）に順延しますか？

  「明日の募集OK」= 明日もう一度出欠を取ってよい、という意思表示です。
  （※ この時点では参加確定にはなりません）

  全員が【明日の募集OK】を押したら、明日 18:00 に再度出欠確認を送ります。
  1人でも【今週は見送り】を押したら、その週は終了です。
  回答期限: 本日 24:00（深夜を跨ぐ前に回答してください）

  【回答状況】
  - いーゆー    : 未回答
  - おーたか    : 未回答
  - あかねまみ  : 未回答
  - ぽんた      : 未回答
  ```
- **ボタン**: `明日の募集OK` / `今週は見送り`
- **判定**:
  - 4名全員が `明日の募集OK` を押した → 翌日（土曜）18:00 に出欠確認を自動再送
  - 1人でも `今週は見送り` を押した → その週は終了（「今週の桃鉄は見送りです」を投稿）
  - 本日 24:00 までに4名全員の回答が揃わなかった → その週は終了

### 6.3 順延の制約
- **順延は1回のみ**（金曜→土曜の1段階）。土曜日に中止となった場合は **順延確認を出さず**、その週は完全終了。
- 順延後（土曜日）の運用は、送信時刻・締切・集計ルールとも金曜日と同じ（締切 土 21:30、22:00 以降開催）。

---

## 7. 管理コマンド（スラッシュコマンド）

全て実行権限は固定4名のみ。

| コマンド | 機能 |
|---|---|
| `/ask` | 手動で出欠確認を起動（§3.1 の制約あり） |
| `/cancel_week` | その週の運用を緊急スキップ |
| `/status` | 現在の週の募集状況を ephemeral で表示 |

### `/cancel_week` の副作用
- 現在週の状態を `SKIPPED` に遷移
- 進行中の募集メッセージ・順延確認メッセージの**全ボタンを無効化**
- 未送信のリマインド・自動再送予定を取消
- チャンネルに「今週は運用都合により見送りです」を投稿（実行者名を含める）
- 実行時は ephemeral で「本当に今週の運用をスキップしますか？」と**確認ダイアログ**を挟む

---

## 8. データ永続化

### 8.1 保存対象（運用状態）
Bot 再起動時の状態復元と重複実行防止のために必要な情報を保存する。

- **Session**（週次募集本体）
  - `weekKey`（例: `2026-W17`、開催候補日の金曜基準）
  - `candidateDate`（開催候補日、JST）
  - `postponementCount`（0 または 1）
  - `status`（`ASKING` / `POSTPONE_VOTING` / `POSTPONED` / `DECIDED` / `CANCELLED` / `COMPLETED` / `SKIPPED`）
    - 終端状態は `COMPLETED`（通常完了: 開催済 / 順延NG / 順延未完 / 土曜中止）または `SKIPPED`（`/cancel_week` 実行）
    - `CANCELLED` は中止確定直後の一時状態で、順延判定または週終了処理を経て `COMPLETED` または `POSTPONED` に遷移する
    - 中止・完了の詳細理由は `cancelledReason` テキストに保存（例: `absent_by:<memberId>`, `deadline_no_response`, `postpone_rejected`, `postpone_timeout`, `saturday_cancelled`）
  - `channelId`、`askMessageId`、`postponeMessageId`
  - `deadlineAt`（締切日時）、`remindAt`（リマインド予定）、`remindSentAt`（送信済み時刻）
  - `cancelledReason`、`decidedStartAt`
  - **一意制約**: `(weekKey, postponementCount)` で一意（同一週・同一順延回数に active は1件のみ）
- **Response**（各メンバーの回答）
  - `sessionId`、`memberId`、`choice`（`T2200`/`T2230`/`T2300`/`T2330`/`ABSENT`/`POSTPONE_OK`/`POSTPONE_NG`）、`respondedAt`
  - 同一 Session × Member で一意（更新上書き）

### 8.2 開催履歴（将来の桃鉄戦績集計システムと統合前提）
永続的に保持：
- **HeldEvent**
  - `eventDate`（実開催日）
  - `startAt`（開始時刻）
  - 紐づく Session
  - 参加メンバー一覧（`HeldEventMember`）

### 8.3 保存しないもの
- 回答の変更履歴（最新の回答のみ保持）
- 中止回の詳細（`Session` に残るが `HeldEvent` は作成しない）

---

## 9. 状態遷移図

```
         ┌──────── /ask, 金18:00 ──────┐
         ▼                              │
     [ASKING] ──── 欠席押下 ───→ [CANCELLED] ──┐
         │                                     │
         │ 締切到達                            │
         ├── 未回答あり ────────→ [CANCELLED] ─┤
         │                                     │
         └── 全員時刻選択 ──→ [DECIDED] ──→ [COMPLETED]
                                   │
                                   ▼ 開始時刻到達の15分前
                               リマインド送信（remindSentAt 記録）

   [CANCELLED] ┬─ 金曜 ─→ [POSTPONE_VOTING]
               │              │
               │              ├── 全員OK ─→ [POSTPONED] ─→ 翌日 postponementCount=1 の新 [ASKING] 生成
               │              ├── 1人NG ─→ [COMPLETED]（reason: postpone_rejected）
               │              └── 24:00 未完 ─→ [COMPLETED]（reason: postpone_timeout）
               │
               └─ 土曜 ─→ [COMPLETED]（reason: saturday_cancelled / 順延確認なし）

   /cancel_week は任意時点から [SKIPPED] へ遷移（以降のジョブ・ボタンはすべて無効化）
```

---

## 10. 技術スタック

| 層 | 採用技術 | 補足 |
|---|---|---|
| 言語 | **TypeScript**（Node.js **v24 LTS "Krypton"**） | 型安全性。Node 24 は 2025-10 から Active LTS、EOL 2028-04-30。バージョンは `.mise.toml` と `package.json#engines` で固定 |
| パッケージマネージャ | **pnpm v10 系**（`pnpm-lock.yaml`） | 厳格な依存解決、高速インストール。`package.json#packageManager` で版数固定 |
| Node/pnpm バージョン管理 | **mise**（`.mise.toml` を正本） | Node と pnpm を単一ファイルで宣言的に管理。asdf / nvm / fnm は補助的に互換 |
| Discord ライブラリ | **discord.js (v14系)** | ボタン/セレクトメニュー/スラッシュコマンドが容易。Gateway 常駐 |
| ホスティング | **Fly.io** | Gateway 常駐向き、約 $2〜3/月。本番 Docker イメージは公式 `node:24-slim` + `corepack` で pnpm を有効化（mise は本番には含めない） |
| DB | **Neon (PostgreSQL 16)** | 無料枠。有料化された場合は Fly Postgres / Supabase 等へ退避する想定 |
| ORM | **Drizzle ORM**（v0.45 系 stable） | SQL 透明性が高く、将来の戦績集計で複雑な集計クエリを型安全に書きやすい。v1.0 GA 後、もしくは `drizzle-orm` 本体に zod スキーマ生成が取り込まれ `drizzle-zod` が不要となった時点で追従する |
| PG ドライバ | **postgres.js** (`postgres`) | Drizzle 公式推奨。Neon pooler と相性良好 |
| マイグレーションツール | **drizzle-kit** | `generate` で SQL を生成し Git 管理、`migrate` で適用、CI で `check` による履歴整合検証 |
| スケジューラ | **node-cron**（v4 系） | 毎分ポーリングで締切・リマインド判定（in-memory ではなく DB 状態から再計算）。Gateway 常駐済のため追加コスト実質ゼロ |
| ロギング | **pino**（構造化 JSON、stdout） | `sessionId` / `weekKey` / `interactionId` / `messageId` を含める。機微情報は redact |
| バリデーション | **zod**（v4 系） | 起動時 env 検証（Fail Fast）、Discord interaction payload の parse。DB スキーマ連携は `drizzle-zod >= 0.8.0`（zod v4 対応）を使用 |
| テスト | TypeScript 対応テストランナー（例: Vitest） + DB 統合テスト | 実装者の裁量で選定。DB 統合は `services: postgres` / testcontainers / Neon branch のいずれかを使用 |
| 設定管理 | **環境変数（本番: Fly secrets / ローカル: `.env.local`）** | `.env*` は `.gitignore` 対象（`.env.example` のみコミット） |

### 月額費用期待値
**約 $2〜3（300〜450円）**

### 主な環境変数
| 名前 | 例 | 用途 |
|---|---|---|
| `DISCORD_TOKEN` | `xxx` | Discord Bot トークン（secretsで管理） |
| `DISCORD_GUILD_ID` | `12345...` | 運用 Guild ID |
| `DISCORD_CHANNEL_ID` | `12345...` | 投稿先チャンネル ID |
| `MEMBER_USER_IDS` | `id1,id2,id3,id4` | 固定4名の User ID（カンマ区切り、4件ちょうど） |
| `CANDIDATE_TIMES` | `22:00,22:30,23:00,23:30` | 開催候補時刻 |
| `ASK_TIME` | `18:00` | 自動送信時刻（金/土の当日） |
| `ANSWER_DEADLINE` | `21:30` | 回答締切 |
| `POSTPONE_DEADLINE` | `24:00` | 順延確認の回答期限（当日）。値 `"24:00"` は「候補日翌日 00:00 JST」を示す慣習表記として**唯一サポートする**。`25:00` 等の 24 超え表記は非対応 |
| `REMIND_BEFORE_MINUTES` | `15` | 開始前リマインド分数 |
| `DATABASE_URL` | `postgres://...-pooler.../neondb?sslmode=require` | Neon 接続文字列（**アプリ用・pooled connection**） |
| `DIRECT_URL` | `postgres://.../neondb?sslmode=require` | Neon 接続文字列（**マイグレーション用・direct connection**。`drizzle-kit migrate` は DDL 安定性のため direct endpoint を使う） |
| `TZ` | `Asia/Tokyo` | タイムゾーン固定 |
| `HEALTHCHECK_PING_URL` | `https://hc-ping.com/...` | 死活監視用 ping URL（healthchecks.io 等）。未設定なら ping 無効 |

### 非機能・運用要件
- **Fly.io 設定**: `min_machines_running = 1` / auto_stop 無効で**常時起動**。デプロイ戦略は `rolling`（単一インスタンスのため deploy 中に数十秒のダウン窓あり）
- **デプロイ禁止窓**: **金 17:30 〜 翌土 01:00 JST はアプリ deploy を行わない**。README に明記、運用ルールとして遵守（デプロイワークフロー側で時刻ガードを入れる実装も推奨）
- **単一インスタンス運用**: スケールアウトはしない（二重実行防止のため）。将来分散化する場合は DB ベースのジョブロックを導入
- **Discord Interaction 応答**: 3秒以内制約に対応するため、ボタン押下は `deferUpdate()` を先行し、その後 DB 更新 → メッセージ再描画。失敗時は ephemeral で再試行案内
- **Custom ID 設計**:
  - 募集ボタン: `ask:{sessionId}:{choice}`（choice = `t2200`/`t2230`/`t2300`/`t2330`/`absent`）
  - 順延ボタン: `postpone:{sessionId}:{ok|ng}`
  - custom_id は**信頼せず**、ハンドラ側で guild / channel / user / session / choice の各項目を検証してから状態を変更する（詳細と責務は §13 セキュリティ要件）
  - メッセージ再描画は常に DB の Session 状態を正として行う
- **起動時リカバリ**: 起動時に `status IN (ASKING, POSTPONE_VOTING, DECIDED)` の Session を DB から読み込み、締切・リマインド予定を再計算（node-cron の in-memory 状態に依存しない）
- **状態遷移の不変条件**: すべての状態更新は**アトミック**かつ**冪等**でなければならない。4名同時押下や cron との競合でも二重処理・ロスト更新を起こさないこと（実装手段は Drizzle のトランザクション + 条件付き UPDATE / 行ロック / unique 制約など、実装裁量）
- **DB を正本**: Discord API 呼び出しの失敗（`editMessage` 失敗・`messageId` 無効など）は DB 状態の変更を取り消す理由にならない。次の cron tick で DB 状態から再描画を試行する
- **マイグレーション**:
  - 開発: スキーマ編集 → `pnpm drizzle-kit generate`（SQL 差分を `drizzle/` 配下に出力、Git commit）→ `pnpm drizzle-kit migrate` でローカル適用
  - 本番: Fly.io の `release_command = "pnpm drizzle-kit migrate"` で自動適用。**`DIRECT_URL` を使用**（`drizzle.config.ts` で `dbCredentials.url = process.env.DIRECT_URL` とする）。失敗したら新バージョンは起動しない
  - `drizzle-kit push`（スキーマ直押し）は本番では**使用禁止**。必ず生成済み SQL を経由
  - アプリ実行時の接続は `DATABASE_URL`（pooled）を使用。`DIRECT_URL` は **アプリコードから参照禁止**（`drizzle.config.ts` 以外での参照をコードレビューまたは静的解析で拒否する）
- **ログ**:
  - すべての状態遷移・Discord API 呼び出し・エラーを構造化 JSON で stdout に出力
  - `fly logs` で参照。外部ログ集約サービス（Axiom / Logtail 等）は**採用しない**（本 Bot の月間ログ量は最大数十 MB 程度で Fly のストリームログで十分、外部 SaaS の無料枠改変・サ終リスクに追従するコストの方が大きい）
  - 過去ログを残したい場合は `fly logs | tee` で手動保存
- **死活監視**: 外部 cron monitor（healthchecks.io 等の無料枠）を 1 つ登録し、node-cron の毎分 tick 内で ping URL を short-timeout で fetch する。Bot プロセス死亡・Fly.io 障害・Neon 断絶のいずれでも一定時間 ping が来なければ運用者に通知が飛ぶ構成とする。詳細は §13 セキュリティ／監視
- **テスト方針**:
  - 単体: 判定ロジック（集計、開始時刻算出、週キー算出、順延可否、時刻パーサ）を純粋関数として分離しカバー
  - 統合: Drizzle リポジトリ層 + interaction handler（時間依存は fake timer、DB は `services: postgres` / testcontainers / Neon branch のいずれか）
  - E2E は実施しない（Discord API mock の維持コストが高く ROI が低い。代わりに純粋関数の単体テストを厚くする）
- **Secrets 管理**: `DISCORD_TOKEN`、`DATABASE_URL`、`DIRECT_URL`、`HEALTHCHECK_PING_URL` は Fly secrets に登録。ログへのトークン出力禁止（§13 参照）

### Drizzle スキーマ草案（`src/db/schema.ts`）

```ts
import {
  pgTable, pgEnum, text, integer, boolean, timestamp,
  uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const sessionStatus = pgEnum('session_status', [
  'ASKING',
  'DECIDED',
  'CANCELLED',
  'POSTPONE_VOTING',
  'POSTPONED',
  'COMPLETED',
  'SKIPPED',
]);

export const responseChoice = pgEnum('response_choice', [
  'T2200', 'T2230', 'T2300', 'T2330', 'ABSENT', 'POSTPONE_OK', 'POSTPONE_NG',
]);

export const members = pgTable('members', {
  id:       text('id').primaryKey(),                         // Discord User ID
  username: text('username').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const sessions = pgTable('sessions', {
  id:                text('id').primaryKey().$defaultFn(() => createId()),
  weekKey:           text('week_key').notNull(),             // 例: 2026-W17
  candidateDate:     timestamp('candidate_date', { withTimezone: true }).notNull(),
  postponementCount: integer('postponement_count').notNull().default(0),  // 0 or 1
  status:            sessionStatus('status').notNull(),
  channelId:         text('channel_id').notNull(),
  askMessageId:      text('ask_message_id'),
  postponeMessageId: text('postpone_message_id'),
  deadlineAt:        timestamp('deadline_at', { withTimezone: true }).notNull(),
  remindAt:          timestamp('remind_at', { withTimezone: true }),
  remindSentAt:      timestamp('remind_sent_at', { withTimezone: true }),
  cancelledReason:   text('cancelled_reason'),
  decidedStartAt:    timestamp('decided_start_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  weekPostponementUnique: uniqueIndex('sessions_week_postponement_unique')
    .on(t.weekKey, t.postponementCount),
}));

export const responses = pgTable('responses', {
  id:          text('id').primaryKey().$defaultFn(() => createId()),
  sessionId:   text('session_id').notNull()
                 .references(() => sessions.id, { onDelete: 'cascade' }),
  memberId:    text('member_id').notNull()
                 .references(() => members.id, { onDelete: 'restrict' }),
  choice:      responseChoice('choice').notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionMemberUnique: uniqueIndex('responses_session_member_unique')
    .on(t.sessionId, t.memberId),
}));

export const heldEvents = pgTable('held_events', {
  id:        text('id').primaryKey().$defaultFn(() => createId()),
  sessionId: text('session_id').notNull().unique()
               .references(() => sessions.id, { onDelete: 'restrict' }),
  eventDate: timestamp('event_date', { withTimezone: true }).notNull(),
  startAt:   timestamp('start_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const heldEventMembers = pgTable('held_event_members', {
  heldEventId: text('held_event_id').notNull()
                 .references(() => heldEvents.id, { onDelete: 'cascade' }),
  memberId:    text('member_id').notNull()
                 .references(() => members.id, { onDelete: 'restrict' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.heldEventId, t.memberId] }),
}));
```

### `drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out:    './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // マイグレーションは direct endpoint を使う（pooler は DDL 非推奨）
    url: process.env.DIRECT_URL!,
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
```

### DB クライアント初期化（`src/db/client.ts`）

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Fly 常駐で単一インスタンス運用のため軽量プールで十分
const client = postgres(process.env.DATABASE_URL!, { max: 5, prepare: false });
export const db = drizzle(client, { schema, casing: 'snake_case' });
```

> `prepare: false` は Neon の PgBouncer（transaction pooling）互換のための指定。

---

## 11. ローカル開発環境

個人開発でも「clone → 5分で動く」を最優先。SaaS 依存を排除し、オフラインでも開発継続できる構成。

### 11.1 前提ツール
- **mise**（`.mise.toml` が正本。asdf / nvm / fnm 等の互換ツールでも可）
- **Node.js v24 LTS** + **pnpm v10 系**（`.mise.toml` で宣言、`package.json#engines` / `packageManager` でも明記）
- **Docker**（ローカル Postgres 起動に使用）

### 11.2 ローカル Postgres
リポジトリ直下に `compose.yaml` を用意し、PostgreSQL 16 をコンテナ起動する（`pnpm db:up`）。ポート番号・ボリューム名・認証情報などの具体設定は実装者の裁量（サンプルは `.env.example` とあわせて提供する）。

- `DATABASE_URL` / `DIRECT_URL` はローカルでは同一値で良い（pooler は不要）
- **Neon branch** はリリース前の動作確認用の補助（オフライン要件のため主系には使わない）

### 11.3 `.env.example`（コミット対象）
公開可能な雛形を `.env.example` としてコミットし、実値は `.env.local`（gitignore）で管理する。主要な環境変数の一覧は §10 を参照。

### 11.4 pnpm v10 の注意点
- **ライフサイクルスクリプトは既定で無効化**される（v10 から）。本プロジェクトでは `tsx` / `drizzle-kit` / `vitest` が依存する **`esbuild`** で postinstall が必要になるため、`package.json` に以下を明示する:

```jsonc
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```
- 新しい依存を追加したあとにスクリプト実行が失敗したら、まず `onlyBuiltDependencies` の漏れを疑う

### 11.5 パッケージスクリプト（概略）
実装者が `package.json` に以下のような script を整備する（pnpm から実行）:

- `dev`（`tsx watch src/index.ts`）
- `build` / `start` / `typecheck` / `lint` / `test`
- `db:up` / `db:down`（ローカル Postgres）
- `db:generate` / `db:migrate` / `db:check` / `db:seed`（Drizzle）
- `commands:sync`（slash command 登録）
- `setup`（`pnpm install` → `db:up` → `db:migrate` → `db:seed` を一括実行）

初回: `cp .env.example .env.local` → 値を埋める → `pnpm setup` → `pnpm dev` で完結させること。

### 11.6 開発ループ
- ホットリロード: `tsx watch`（`nodemon` は不要）
- DB seed: 固定4名の `Member` レコードを挿入するだけの最小スクリプト
- 時刻依存ロジックの手動検証には「疑似現在時刻を注入できる仕組み」を用意する（実装手段は fake timers 利用 or 時刻取得関数の DI 等、実装裁量）

---

## 12. CI/CD

個人開発の原則「ないと困るもの以外は自動化しない」。Staging 環境は作らない。

### 12.1 GitHub Actions ワークフロー

**PR / main push 時**（CI）:
- `actions/setup-node@v4` で Node 24 を準備、`pnpm/action-setup@v4` で pnpm を有効化、`pnpm install --frozen-lockfile`
- `pnpm lint` / `pnpm typecheck` / `pnpm test`
- **Drizzle 整合性検証**: `pnpm db:check`（migration 履歴の整合）を必須に。`db:generate` を走らせて `drizzle/` に未コミット差分が出た場合は warning（fail は任意）

**main push 時**（Deploy。CI パスを前提）:
- `superfly/flyctl-actions/setup-flyctl`
- `flyctl deploy --remote-only`
- deploy 直後に `pnpm commands:sync`（guild-scoped bulk overwrite）で slash command を同期
- `FLY_API_TOKEN` は **app-scoped deploy token**（`fly tokens create deploy`）を使用。Personal Auth Token は使わない。expiry は運用に合わせて設定（長期でもよいが、漏洩時は即 revoke する運用とする）

ファイル分割（`ci.yml` + `deploy.yml`）か単一ファイルかは実装者の裁量。どちらでも良い。

### 12.2 ブランチ運用
- `main` = 本番デプロイ対象
- feature ブランチで PR → CI 通過 → main へ squash merge
- Dependabot を有効化し週次で依存更新 PR を作る（`npm audit` / `pnpm audit` は**参考情報**として表示するだけで、CI を fail させない）

### 12.3 Zero-downtime について
単一インスタンス前提のため **deploy 中は数十秒ダウンする**。§10 のデプロイ禁止窓（金 17:30〜土 01:00 JST）を守ることで十分。staging は不要。

---

## 13. セキュリティ要件

「攻撃耐性」ではなく「個人開発で実際に起きるオペレーションミス／バグ」への対策に絞る。

### 13.1 Discord Bot の最小権限
- **OAuth2 scopes**: `bot`, `applications.commands` のみ
- **Gateway Intents**: `Guilds` のみ（`GuildMessages` / `MessageContent` / `GuildMembers` は**不要**）
- **Bot Permissions**: `View Channel` / `Send Messages` / `Embed Links` のみ
- Bot 招待時の Permissions Integer は上記最小で生成し、`.md` に記録

### 13.2 Interaction 検証（実装必須）
interaction handler の先頭で以下を**必ず全てチェック**してから状態変更を行う（失敗時は ephemeral で却下し、状態変更しない）:

- `interaction.guildId === env.DISCORD_GUILD_ID`
- `interaction.channelId === env.DISCORD_CHANNEL_ID`
- `interaction.user.id ∈ env.MEMBER_USER_IDS`
- `customId` は zod で parse し、`sessionId` / `choice` が正しい形式・enum 値であること
- DB から Session を引き、`status` が現在の操作を受け付ける状態であること

検証順序はパフォーマンス上「安い順」を推奨するが、厳密な順番は実装裁量。処理受付後に `deferUpdate()`（3 秒制約）→ DB 更新の順で進める。

> Bot は Gateway 経由で interaction を受信するため、**HTTP Endpoint Ed25519 署名検証は不要**。将来 Interactions Endpoint URL を採用する場合のみ実装。

### 13.3 環境変数の厳格検証（zod）
```ts
const Env = z.object({
  DISCORD_TOKEN: z.string().min(50),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  DISCORD_CHANNEL_ID: z.string().regex(/^\d{17,20}$/),
  MEMBER_USER_IDS: z.string()
    .transform(s => s.split(',').map(x => x.trim()))
    .pipe(z.array(z.string().regex(/^\d{17,20}$/)).length(4)),  // 4件ちょうど強制
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  TZ: z.literal('Asia/Tokyo'),
  // ... 他の時刻系
});
// 起動時に parse 失敗したらプロセスを exit(1)
```

### 13.4 Secrets 管理
- 本番: **Fly secrets** のみ（encrypted vault、API 経由で decrypt 不可）
- ローカル: `.env.local`（gitignore）
- `FLY_API_TOKEN` は **app-scoped deploy token**（`fly tokens create deploy`）を使用。Personal Auth Token は CI に登録しない。漏洩時は即 revoke する運用
- Discord Bot トークンは **ログ・エラーメッセージ・Discord チャンネルに絶対出さない**

### 13.5 ログ衛生
- pino の `redact` でトークン・接続文字列・`Authorization` ヘッダなど機微情報を除去する（具体的な path リストは実装裁量）
- interaction payload を丸ごとログに出さない。必要な識別子（`interactionId` / `userId` / `customId` / `sessionId` 等）に限定する

### 13.6 DB アクセス
- Drizzle の `sql\`\`` テンプレートリテラル（プレースホルダ）を徹底。`sql.raw()` にユーザー入力を渡さない
- 動的 ORDER BY 等が必要な場合は**許可カラム名のホワイトリスト**で解決
- `DIRECT_URL` は `drizzle.config.ts` 以外のアプリコードから参照しない。コードレビューまたは簡易な grep ベースのチェックで担保する（ESLint カスタムルールまでは必須ではない）

### 13.7 Slash Command 登録
- **Guild-scoped** bulk overwrite（グローバル登録は使わない）。伝播即時で運用事故が少ない
- deploy ごとに無条件で同期する（bulk overwrite は冪等なので差分判定のためのハッシュ比較は不要）
- 開発用 guild と本番用 guild を分けて運用することを推奨（環境変数 `DISCORD_GUILD_ID` で切替）。強制ではない

### 13.8 死活監視
- node-cron の毎分 tick 内で `HEALTHCHECK_PING_URL`（healthchecks.io 等の無料サービス）に短タイムアウトで HTTP GET を投げる
- 監視サービス側で「数分間 ping が来なければ通知」を設定し、Bot プロセス死亡・Fly.io 障害・Neon 障害のいずれでも運用者に通知が飛ぶ状態にする
- 通知チャネルはメール / Discord Webhook のいずれか

### 13.9 依存関係の脆弱性管理
- **Dependabot** を有効化し、週次で依存更新 PR を受け取る
- `pnpm audit` / `npm audit` は CI で**情報表示のみ**（fail 条件にはしない。個人 Bot で高 severity のマイナー誤検知で開発停止するコストのほうが大きいため）
- 新規依存の追加は手動レビュー（README / スター数 / メンテナンス状況の確認）で十分

---

## 14. 実装時の境界条件と落とし穴

実装前に方針を確定しておかないと金曜深夜に燃える項目。具体的なファイル配置・関数名・数値などは実装者裁量であり、ここでは不変条件と観点のみ記す。

### 14.1 時刻処理
- 時刻計算（「今」の取得 / 開始時刻算出 / 週キー算出 / `POSTPONE_DEADLINE` 解釈）は単一モジュールに集約し、他のコードから直接 `new Date()` や文字列操作を行わない
- **`POSTPONE_DEADLINE="24:00"`** は「候補日翌日 00:00 JST」として解釈する慣習表記。`25:00` などの 24 超え表記は非対応（§10 参照）
- **ISO week key**（`YYYY-Www`）は `date-fns` の `getISOWeek` + `getISOWeekYear` などで算出する。金曜基準でも**年跨ぎ境界**（例: 12/31 金曜の翌 1/1 土曜）では ISO year が変わるため、境界テストを必須とする
- 金曜 Session（`postponementCount=0`）と土曜 Session（`postponementCount=1`）は同じ `weekKey` を共有する。年跨ぎケースでもこの不変条件が崩れないこと
- テスト容易性のため「現在時刻の取得」は差し替え可能にしておく（実装手段は fake timers / 関数 DI / Clock オブジェクト 等、実装裁量）

### 14.2 状態遷移レース（4名同時押し／cron 締切との競合）
21:30 前後や全員が「せーの」で押すシナリオで、DB 更新と Discord 編集が並列発行される。

**不変条件**:
- 状態遷移は**アトミック**かつ**冪等**であること（二重処理・ロスト更新が発生しない）
- `/cancel_week` は他のどの進行中処理よりも優先して `SKIPPED` に遷移できる
- cron tick は失敗しても次 tick で回復し、同じ tick の二重実行でも結果が変わらない

**実装の目安**（必須ではない。チーム規模・負荷に応じて選ぶ）:
- Drizzle のトランザクション + 条件付き UPDATE（`WHERE status = ...`）で多くのケースは解決する
- 厳密な直列化が必要な箇所のみ行ロック（`SELECT ... FOR UPDATE`）を使う
- response upsert には `(sessionId, memberId)` の unique 制約を置き、挿入競合はアプリ層で吸収する

### 14.3 Discord API 失敗時の整合性
DB 更新成功 → `editMessage()` 失敗、のような片肺状態への対応。

**方針**:
- **DB を正本**とする。`editMessage` 失敗はログに記録し、次の cron tick で Session 状態から再描画を試行する
- `messageId` が無効（メッセージ削除／権限変更）の場合は新規投稿し、Session の参照メッセージ ID を更新する
- 再試行には上限を設け、上限到達時はエラーログに残して人間が確認する（具体的な回数・タイムアウト値は実装時に設定）

### 14.4 deferUpdate の 3 秒制約
ボタン押下直後に `deferUpdate()` を呼び、以降の DB / editMessage 処理は非同期で実行。3 秒以内に defer できないとインタラクションが失効する。

### 14.5 メンバー追加・削除への対応（運用上の注意）
- `MEMBER_USER_IDS` 変更は Fly secrets 更新 → 再デプロイが必要（ダウンが生じる）
- 変更は運用ウィンドウ外（§10 デプロイ禁止窓に準じる）で実施
- 将来的には `Member` テーブル正本化（§15 将来拡張）

---

## 15. 将来拡張の可能性

本仕様の対象外。個別に再仕様化した上で追加する。

- **桃鉄対戦結果記録システム**との同一 DB 統合（順位・資産・物件数等）
- **Web ダッシュボード**による戦績可視化（Next.js 等で Neon に直接接続）
- **メンバー管理の動的化**（現状は `.env` 固定だが、`Member` テーブルを正本化）
- **祝日・スキップ週の事前登録**機能
- **通知設定のカスタマイズ**（サイレント通知、個別 DM 切替など）

---

## 16. 決定済み仕様サマリー

| 項目 | 決定内容 |
|---|---|
| 締切 | 金 21:30 JST（順延時は土 21:30） |
| 自動送信 | 金 18:00 JST（順延時は土 18:00） |
| 回答UI | 5ボタン（22:00/22:30/23:00/23:30/欠席）を1メッセージ内に配置 |
| 集計 | 「それ以降参加可能」解釈、開始時刻 = 選択時刻の最遅値 |
| 欠席挙動 | 1人でも欠席→即中止、残り回答打ち切り |
| 回答変更 | 締切まで可、中止確定後は不可 |
| 順延判断 | 4名全員が「明日の募集OK」で翌日再出欠。1人でもNG or 24:00までに未完なら週終了 |
| 順延回数 | 1回のみ（土曜まで）。土曜中止時は順延確認なし |
| メンション | 出欠確認・中止・順延確認 = 4名全員 / 開催決定・15分前リマインド = 参加者（4名） |
| 投稿先 | 専用チャンネル1箇所 |
| コマンド権限 | 固定4名のみ |
| スキップ | `/cancel_week` で緊急スキップ（事前スケジュール機能は不要） |
| 履歴保存 | 開催日・開始時刻を永続保存（将来の戦績集計システムと統合前提） |
| 設定管理 | 環境変数（Fly secrets） |
| 技術スタック | TypeScript (Node 24 LTS) + pnpm v10 (mise 管理) + discord.js v14 + Fly.io + Neon(Postgres 16) + Drizzle 0.45 (postgres.js) + drizzle-kit + drizzle-zod 0.8+ + node-cron + pino + zod v4 |
| ロギング / 死活監視 | stdout に pino JSON → `fly logs`。外部ログ SaaS は不採用。死活監視は healthchecks.io 等への毎分 ping |
| 月額費用 | 約 $2〜3 |
