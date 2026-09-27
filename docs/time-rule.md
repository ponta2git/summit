# Time Rule

JST、clock、ISO week、candidate / deadline の計算契約を定める。業務上の意味は [requirements](../requirements/base.md)、実行値は user config と [config](../src/config.ts)、計算は [src/time](../src/time/) が正本。

## 1. Clock と timezone

業務判定と表示は `Asia/Tokyo` に固定する。`Date` の内部表現や構造化 log の timestamp が UTC でも、業務時刻は JST として解釈する。実行 host の暗黙の local timezone を判断に混ぜない。日本国内の固定運用で DST は対象外とする。

[env](../src/env.ts) が bootstrap の早期に TZ を既定化し、[envSchema](../src/envSchema.ts) が `Asia/Tokyo` だけを許可する。他 timezone の許可だけを単独で追加しない。

現在時刻は `AppContext.clock` から得る。handler / scheduler / repository fake が global system clock を直接読まない。集約は渡された同一の clock snapshot で lock 後の期限・状態を判定し、read と write の間に別の global now を挟まない。

`/ask` の重複抑止キーと Session 作成、開催確定と reminder skip はそれぞれ一つの snapshot を共有する。Discord 編集の待機時間を開催確定時刻として扱わない。process 内の募集抑止は AppContext ごとに所有する。

## 2. 計算の所有者

`src/time/` が現在時刻、ISO week、候補日、金曜から土曜への変換、deadline、slot からの開始時刻、reminder、JST format、HH:MM 境界、duration 加減算を所有する。

その外の production code で、`new Date()` による現在時刻取得、`Date.parse`、日付文字列の手組み、独自 week key、deadline の minute / millisecond 直書きを追加しない。DB から復元済みの Date 比較や snowflake の順序比較は、時刻生成でなければ許容する。

slot の業務意味は [slot](../src/slot.ts)、candidate との合成は time が担当する。日付文字列には `*Iso` suffix を使い、Date と区別する。config の文字列は起動時に検証し、利用側で繰り返し split / parse しない。

## 3. 境界の意味

| 境界 | 守る判断 |
|---|---|
| ISO week | ISO week year + ISO week number を date-fns の関数で求める。calendar year と週番号を組み合わせない |
| 金曜から土曜 | 元 Session の week key を引き継ぐ。年跨ぎでも土曜側で再計算して分裂させない |
| `/ask` | 実行時点の ISO week に初回募集を一件だけ作る。非金曜の候補日は requirements の意味に従う |
| `24:00` | 候補日の翌日 00:00 だけを表す特別な境界。それ以外の 24 時超表記は parse で拒否 |
| candidate ISO date | 実在日付だけを許可し、翌月への繰上がりや 0〜99 年への 1900 加算を許さない |
| deadline / reminder | 同じ clock snapshot と正本の設定値で判定する。直前・同時・直後、送信 / skip を区別 |

HH:MM、lead time、skip threshold は user config / `src/config.ts` を参照し、文書・comment に実行値を複製しない。値を変える前に、それが表す業務条件を requirements で確認する。

reminder lead duration は正の分数として表示にも使い、予定時刻の計算だけで減算する。文面の期待値を符号付き計算用定数から生成しない。

## 4. Scheduler との接続

cron に JST timezone を明示し、due は DB hint と `ctx.clock.now()` で判定する。timer は派生状態であり、wake・startup・reconnect・supervisor から再構築できるようにする。停止中に deadline を超えた Session は startup recovery で収束させる。

one-shot、同種 due の再実行抑止、wake の保持、shutdown drain は [Architecture §6](./architecture.md#6-scheduler-と-lifecycle) が所有する。時刻変更でこれらも変わる場合だけ同章を確認する。

## 5. Clock skew

host の NTP 同期を信頼し、application 独自の NTP query・自動補正・複数の時刻正本を追加しない。

軽微なずれは処理遅延として DB-driven recovery で収束する。大きなずれは week key や順延窓そのものを誤らせるため、unique / 集約 command だけでは意味を修復できない。`/status` の JST 表示と構造化 log で調べ、[time-skew runbook](./operations/time-skew.md) に従う。本番 DB の手動修正や、禁止窓内の ad-hoc deploy / restart / schema 変更へ進まない。

実 incident、目視運用の限界、複数 host の drift、provider の同期保証変更、信頼できる代替 clock を持つ scheduler 基盤への変更があれば検知・時刻源を再評価する。

時刻の変更は [テスト規約 §5〜6](./test-rule.md#5-race-と-time) の fixed clock・境界テストと [§8 の gate](./test-rule.md#8-quality-gate) で検証する。根拠の入口は [time tests](../tests/time/)。
