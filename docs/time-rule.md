# Time Rule

Summit のJST解釈、ISO week、candidate/deadline、clock injection、schedulerとclock skewの契約を定める。ユーザーに見える時刻・締切は`requirements/base.md`、実行される値はuser configと`src/config.ts`、計算実装は`src/time/`が正本である。

## 1. 基準時刻

- 仕様判定、表示、logはすべて`Asia/Tokyo`として解釈する。
- `Date`内部表現がUTCであることは許容するが、local timezone依存の暗黙変換を業務判定へ持ち込まない。
- 日本国内の固定運用でありDSTは考慮しない。
- `src/env.ts`がbootstrap早期にtimezoneを固定する。別timezoneを許可するenv拡張を単独で行わない。
- 現在時刻は`AppContext.clock`から得る。handler、scheduler、repository fakeがglobal system clockへ直接依存しない。

## 2. 計算の所有権

次の処理は`src/time/`に集約する。

- 現在時刻の取得とfake clock contract
- ISO week key
- 募集候補日
- 金曜から土曜候補への変換
- 回答deadlineと順延deadline
- slotから開催決定時刻への変換
- reminder予定
- 表示用JST format
- `24:00`境界のparse
- duration加減算

`src/time/`以外のproduction codeで、次を使って業務時刻を構築しない。

- `new Date()`による現在時刻取得
- `Date.parse()`
- 日付文字列の手組み
- `getFullYear()`等を組み合わせた独自week key
- deadlineのminute/millisecond直書き

DBから復元済みの`Date`比較やDiscord snowflakeの順序比較は、それ自体が時刻生成でなければ許容する。

## 3. ISO week

- week keyはISO week yearとISO week numberの組で算出する。calendar yearだけを使わない。
- 実装はdate-fnsのISO week関数を併用し、自作しない。
- 金曜Sessionとそこから作る土曜Sessionは同じweek keyを共有する。
- 年末金曜から年始土曜へ跨ぐ場合も、土曜側でweek keyを再計算して分裂させない。
- `/ask`は実行時点のISO weekに対して初回募集を一件だけ作る。非金曜候補日の業務仕様は`requirements/base.md`に従う。

## 4. Candidate、deadline、slot

- user configの文字列は起動時にzodで検証し、利用側で繰り返しsplit/parseしない。
- `24:00`は候補日の翌日00:00だけを表す特別な境界表記とする。それ以外の24時超表記はparse時に拒否する。
- candidate日付の文字列には`*Iso` suffixを使い、`Date`と区別する。
- slotの業務意味は`src/slot.ts`、candidateとの合成は`src/time/`が所有する。
- deadline判定はaggregate lock後の同じclock snapshotで行い、readとwriteの間に別のglobal `now`を取得しない。
- 実際のHH:MM、lead time、skip thresholdはrequirements、user config、`src/config.ts`を参照し、設計文書やコメントへ複製しない。

## 5. Schedulerとの関係

- cronはJST timezoneを明示する。
- due判定はDB hintと`ctx.clock.now()`で行う。
- timerは正本ではない。wake、startup、reconnect、supervisorのたびにDBから再構築できること。
- process停止中にdeadlineを超えたSessionはstartup recoveryでsettleする。
- 同じdue kindが外部配送待ちでdueのまま残る場合、一回のrecomputeで無制限に再実行しない。
- fake timer testでは`createTestAppContext({ now })`と明示的なtimer advanceを組み合わせる。

## 6. Clock skew

hostのNTP同期を信頼し、applicationから独自NTP queryや自動clock補正は行わない。

- 軽微なskewはdeadline処理の遅延として扱い、その後のDB-driven recoveryで収束する。
- 大きなskewでは誤ったweek keyや順延窓判定が起こり得る。`/status`のJST表示と構造化logで検知し、`docs/operations/time-skew.md`に従う。
- uniqueとaggregate commandはDB内部の重複・部分更新を抑えるが、誤ったweek keyで作られたSessionの意味までは修復しない。
- skew疑いがある状態でproduction DBを手動修正しない。
- deploy禁止窓内ではclock対応を理由にad-hoc deploy/restart/schema変更を行わず、runbookの安全な手順に従う。

自動検知は、実incidentが観測された場合、目視運用が規模に合わなくなった場合、またはscheduler基盤変更で信頼できる代替clockが得られる場合に再評価する。

## 7. テスト必須境界

時刻契約の変更が影響する境界を次から選び、`docs/test-rule.md` の品質 gate と合わせて検証する。

- ISO week yearの年跨ぎ
- 金曜/土曜Sessionのweek key共有
- `24:00`の翌日境界と不正な24時超表記
- deadline直前/同時/直後
- reminderが送信対象/skip対象になる境界
- 非金曜`/ask`のcandidate日
- process停止中にdeadlineを超えたstartup recovery
- clock固定時にfake portのcreated/updated時刻が再現可能であること
- due rowが配送待ちで残ってもscheduler recomputeがloopしないこと

race testでwall-clock sleepを使わず、fake clockと明示的な同期点を使う。
