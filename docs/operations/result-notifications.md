# OCR・分析通知の運用

A/Bの状態確認・再試行・設定と、停止切替を扱う。出欠アンケートは[outbox.md](outbox.md)。保存・取消は[DB規約](../db-rule.md)、更新境界は[共有契約](../../../momo-db/docs/discord-notifications.md)が正本。productionの操作には[運用入口](README.md#実行権限と準備)の実行権限・禁止窓を適用する。

## 起動設定と受信

`.env.example`の項目を環境へ注入する。実値をcommand引数、履歴、ログ、Issueへ貼らない。

| 項目 | 意味 |
| --- | --- |
| RESULT_NOTIFICATION_TOKEN | producerの受付専用Bearer token |
| RESULT_NOTIFICATION_OPERATIONS_TOKEN | 状態確認・設定・retry用の別token |
| RESULT_NOTIFICATION_WEB_ORIGIN | Webのorigin。パス・認証情報・queryを含めない |
| RESULT_NOTIFICATION_BIND_HOST | private受信アドレス。既定はfly-local-6pn |
| RESULT_NOTIFICATION_PORT | private受信ポート。既定値はsrc/notifications/config.ts |
| RESULT_NOTIFICATION_URL | CLIだけの任意接続先。private HTTP origin |

token2項目とWeb originをすべて設定するとreceiverとconsumerが有効になる。3項目未設定なら既存Botだけが起動する。部分設定、tokenの兼用、public bindは拒否する。投稿先は既存user configの専用チャンネル。Flyの公開HTTP serviceは追加しない。ローカルではloopbackを使う。

producerはprivate接続の `POST /internal/discord-notifications` にBearerとJSONを送る。startup前は503、commitした新規受付は202、重複・取消受付は200。400/409/413/422は内容・識別・上限・versionを確認する。503やtimeoutだけでは未受付と断定しない。接続・本文・並行受付・DB・送信の上限は `src/notifications/config.ts` が正本。

## 通知IDで確認する

稼働中の同じreceiverへ、設定を安全に注入した運用環境からCLIを実行する。CLIは別Botを起動せず、Discordへの直接送信も行わない。

```bash
pnpm notifications inspect result:ocr_completed:example-job
pnpm notifications inspect result:analysis_completed:example-job
pnpm notifications settings ocr_completed
pnpm notifications settings analysis_completed
```

production imageでpackage managerを使わない場合は `node dist/notifications/cli.js` に同じ引数を渡す。HTTPの対応は `GET /internal/discord-notifications/:id`、設定は `GET /internal/discord-notifications/settings/:kind`。

| 状態 | 読み方・対応 |
| --- | --- |
| 404 | 同じIDの受付記録なし。未受付分を現在データから再構築しない |
| PENDING | 次回試行時刻を待つ。新規受付時のwake、DB接続、次回timerを確認 |
| IN_FLIGHT | 所有権期限とpartsを確認。遅い送信中は期限を延長する |
| DELIVERED | 全partの配送記録がある。再送対象にしない |
| FAILED | 安全なlastErrorとretryableを見て原因を直す。起動だけでは再試行しない |
| CANCELLED | cancelReasonを確認。再ON・再起動・retryで復帰させない |
| purgedAtあり | 本文・partsは保持期限で整理済み。識別と終端は残るが再送できない |

`partCount`とpartsの状態、`deliveredMessageId`で途中までの配送を確認する。状態APIはpayloadやtokenを返さない。保存したIDの操作だけで調査し、SQLの手動更新で復旧しない。

ログは `result_notification.received`、`part_delivered`、`delivery_failed`、`claim_lost`、`lease_uncertain`、`finalization_uncertain`、`dispatch_unavailable` 等。実際のevent名には共通の `result_notification.` prefixが付く。通知ID、種別、part、試行数、次回時刻、安全なcodeで照合する。

## FAILEDの明示再試行

Discord権限・到達性・描画互換性などの原因を解消し、`inspect`で `retryable=true` を確認してから、同じIDを指定する。

```bash
pnpm notifications retry result:analysis_completed:example-job
```

対応は `POST /internal/discord-notifications/:id/retry`。受付commit後に同じprocessをwakeし、同じpayload・renderer・部分計画・宛先・nonceで未配送partだけを再開する。回数を無制限に戻す処理ではなく、retryCycleを進めて新たな有限cycleを開始する。409は取消・未FAILED・保持終了などの不適格を示す。

運用requestの応答を失った場合も、まず同じIDをinspectする。新しいIDや変更payloadで通知を作らない。Discord受理後の停止では重複があり得るため、送達記録と実際のmessageを照合する。

## ON/OFF

設定変更は通知の世代と未開始部分取消を同じcommandで行う。

```bash
pnpm notifications settings ocr_completed off
pnpm notifications settings ocr_completed on
```

対応は `PATCH /internal/discord-notifications/settings/:kind` と `{"enabled":false}` / `true`。OFF時も既送達partは残り、開始済みpartは届き得る。ONへ戻しても古い世代・取消済み通知は戻らない。運用tokenをproducerや利用者のブラウザへ共有しない。

受信tokenを更新するときはproducer側との切替を揃え、その間の受付前欠落を考慮する。運用tokenは別に更新できる。保存済み通知の配送はこれらのtoken変更で消えない。詳細は[secrets rotation](secrets-rotation.md)。

## 遅延・停止からの回復

- 起動時と受付commit後にwakeする。Discord再接続中もstartup完了後なら永続受付できる。
- 送信中のclaim失効は旧ownerの確定を拒否し、次回回収で未配送部分を再開する。送信上限を過ぎた不明な送達も保存済みnonceを使う。
- DB一時障害では有限backoff後に待機する。既存supervisorか新しい受付・再接続wakeで再開する。idle時の常時pollingを増やして対処しない。
- `shutdown.drain_timeout` は未完了claimが残り得ることを示す。次の起動後に同じIDを確認する。
- A/Bの長文・失敗と出欠通知の配送は独立する。出欠側の警告は別runbookで判断する。

## 移行とrenderer互換性

[migration.md](migration.md#共有通知への停止切替)に従い、全writer・配送停止、復元確認済みbackup、対応するmomo-db・Summit・momo-result APIを揃える。

0044でdelivery contextを追加し、0045で通知の業務関数・triggerを撤去する。旧関数を呼ぶconsumerと、triggerに取消を依存するwriterを稼働させない。停止中に戻す場合はDBと全consumerを対応した組合せで戻し、再開後は新規データを守るforward fixを原則とする。

保持中のresultで `partCount>0` なのに旧宛先contextがない場合、`unsupported_renderer`へ収束する。現在の宛先で続きを送ることはしない。旧renderer・分割・宛先を確認できる回復版を別途検証する。単純retryでは原因は解消しない。

rendererを変更・撤去できるのは、その版を必要とする保持中の通知がなく、対応するfixture・停止回復試験と切戻し方法を確認した場合だけ。リンクoriginやチャンネルの設定変更も、計画済み通知には反映しない。

## 実環境での受入

MOM-19では実producer・private network・Discordを通して、A/B正常系、長文、OFF・対象削除、起動回復、応答喪失と重複、業務成功から投稿までの目標時間を確認する。ローカルのfake Discord / 実DB testだけで実環境の到達性や時間目標を達成したと報告しない。
