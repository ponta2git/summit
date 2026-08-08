# Discord Rule

Discord Interaction、route、custom ID、公開メッセージ、再描画、通知の現在の契約を定める。業務上のボタン意味と状態遷移は `requirements/base.md`、DB transaction と outbox は `docs/db-rule.md` を正本とする。

## 1. Interaction の処理順

Discord の応答期限を守るため、入口で ack してから検証する。

### Component

1. `deferUpdate()`
2. application readiness の確認
3. guild / channel / member の cheap-first guard
4. registry で route 解決
5. custom ID を zod codec で parse
6. DB から Session を再取得し、現在状態と actor を検証
7. Session aggregate command で書き込む
8. commit 後の DB snapshot から公開メッセージを再描画

### Slash command

1. `deferReply` または即時 `reply`。通常の応答は ephemeral とする
2. guild / channel / member を検証
3. option を zod 等で narrow
4. application operation を実行
5. `editReply` で結果を返す

検証前に状態変更や DB read を行わない。押下元メッセージの文面、custom ID、client-side の表示状態を最新状態として信用しない。

readiness が false の startup / reconnect replay 中は、処理を開始せず ephemeral で再試行を案内する。Component は ack を失わないよう、readiness 判定時も先に defer する。

## 2. Guard と入力

guard の順序は安価で信頼できるものから固定する。

1. configured guild
2. configured channel
3. configured fixed member
4. typed payload / custom ID
5. persisted Session と現在 status

- 不正入力は状態変更せず、公開チャンネルを汚さない ephemeral response にする。
- raw Interaction payload 全体をログへ出さない。`interactionId`、`userId`、`customId`、`sessionId`、`weekKey` 等の診断識別子に絞る。
- stale button、unknown command、期限切れ状態は通常の拒否経路であり、process error にしない。
- user ID は Discord が認証した actor として使うが、custom ID 内の session/choice は常に untrusted input とする。

## 3. Feature registry

route の正本は各 `src/features/<feature>/module.ts` と `src/discord/registry/modules.ts`。

- 新 feature は feature 内に `module.ts` を置き、aggregator へ一度だけ追加する。
- dispatcher や `src/commands/definitions.ts` に feature 名の条件分岐を追加しない。
- button prefix は `:` で終え、他 prefix と重複・包含しない。
- command name は registry 全体で一意にする。
- registry build の不整合は起動時 fail-fast とする。
- handler signature を route 種別ごとに統一し、feature 固有の依存は `InteractionHandlerDeps` から渡す。

## 4. Custom ID

wire format とcodecの実装正本は `src/discord/shared/customId.ts`。

- 文字列の split/regexを handler ごとに実装せず、encode/decodeを一箇所へ集約する。
- parse成功後のdiscriminated unionだけを業務処理へ渡す。
- slotの意味は `src/slot.ts`、wire上のchoice対応はcustom ID codecが所有する。
- `/cancel_week` のnonce付きconfirmationはSession IDを中央要素とするrouteとは意味が異なるため、独立codecとして扱う。
- formatを変える場合は、既存メッセージ上のstale button、後方互換、拒否文言を同時に設計する。

HMAC署名は現在採用しない。private guild・固定4名では、actorはDiscord側で認証され、改変されたsession/stateはDB検証とCASで拒否できるためである。外部guild展開、信頼できないmember、custom IDだけで権限が確定する操作を導入する場合は、versioning・HMAC・secret rotationを一体で再評価する。

## 5. DB 正本と再描画

- Interaction write は `SessionCommandsPort` の aggregate commandを使う。Response writeとstatus transitionを別callで組み立てない。
- 同時押下、遅延Interaction、deadlineとの競合はDB lock、snowflake fencing、unique、CASで吸収する。
- 公開メッセージはcommit後に最新Session + Responseからrenderする。
- `message.edit`失敗でDBを巻き戻さない。次のInteraction、reconciler、startup recoveryで再同期する。
- 既存message IDがDiscord側で消えている場合、reconcilerが再投稿し、DBのmessage IDをCASでbackfillする。
- 新規の業務上必須投稿は同期sendではなくtyped outbox intentへ入れる。既存messageのeditはbest-effort経路に残す。
- DB commit前にDiscord APIを待たない。外部API待ち中にrow lockを保持しない。

DiscordとPostgreSQLを同じtransactionにできないため、exactly-onceは保証しない。必須投稿は欠落回避を優先し、Discord受理後・DB確定前の停止では重複を許容する。詳細は `docs/db-rule.md` を参照する。

## 6. User-facing copy と通知

- ユーザー向け文言はfeature-localな`messages.ts`、button labelはfeature-local constantsに置く。
- 通常の時刻回答と順延OKは、公開メッセージの回答状況更新を主feedbackとし、成功ephemeralを追加しない。
- 欠席、順延不可、週取消など結果が大きい操作は、誤押下防止のephemeral confirmationを使う。
- 権限外、stale、期限切れ、内部失敗はephemeralで返す。
- mentionは「今すぐ行動が必要」または「開始直前」に限定する。
- 金曜中止後は、単なる中止通知ではなく次の行動を求める順延確認側でmentionする。
- 土曜中止のように次actionがない最終通知、開催決定、開始前reminderは見落とし防止の対象mentionを維持する。
- 文言は短く自然で非難しない日本語にする。「お流れ」は現在の業務語彙として維持する。
- `dev.suppressMentions` は開発時だけmentionをplain textへ変える。表示名とmember identityはuser configを使う。

ユーザーから個別成功通知が必要という継続的feedbackが出た場合、またはmember/channel数の増加でmentionが騒がしくなった場合に方針を再評価する。

## 7. Slash command sync と権限

- command登録はguild-scoped bulk overwriteのみ。global登録は使用しない。
- command定義変更後は`pnpm commands:sync`を実行する。
- OAuth2 scope、Gateway Intent、Bot PermissionはREADMEに示す最小集合を維持する。
- 新しいpermissionが必要なら、機能実装前に理由と攻撃面を設計文書・PRへ記載する。

## 8. Error handling

- Discord API失敗とdatabase失敗を同じ回復方法で扱わない。
- DB未commitならoperation errorとして上位へ返す。
- DB commit済み・Discord edit失敗ならDBを維持し、recoveryへ委譲する。
- route handler最外周でerrorをlogし、まだreply可能ならgeneric ephemeral errorを返す。
- error通知自体の失敗は二重障害としてunhandled rejectionにしない。
- rate limit情報はrouteとretryAfterなど必要な値に限定して構造化logへ記録する。

## 9. 変更時の検証

- ackがDB/API処理より先であること。
- wrong guild/channel/member、malformed custom ID、stale stateがwriteしないこと。
- registryのduplicate/prefix包含がfail-fastすること。
- 同時押下と遅延snowflakeが最新回答を壊さないこと。
- DB更新後のmessage edit失敗でDBがrollbackされないこと。
- Unknown Messageから再生成・message ID backfillへ収束すること。
- confirmationのconfirm/abort/replayが冪等であること。
- user-facing copyとmention policyを具体payloadで検証すること。
