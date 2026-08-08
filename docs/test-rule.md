# Test Rule

Summit のテスト選択、fake/real boundary、assertion、race/time検証、品質ゲートを定める。テストはproduction内部の実装順ではなく、業務仕様、永続化契約、外部副作用境界を固定する。

## 1. テスト層

| 層 | 主な対象 | 使用する境界 |
|---|---|---|
| pure unit | domain decision、time、codec、view model、render | 具体入力と厳密な期待値 |
| application unit | handler、orchestration、scheduler | `createTestAppContext`、fake ports、Discord fake |
| repository contract | lock、CAS、unique、transaction、outbox | `tests/integration/**`とreal PostgreSQL |
| configuration | env/user config parse、registry build | isolated inputとfail-fast期待 |
| deterministic verification | 禁止pattern、文書topology、生成adapter | `scripts/verify/` |

同じ意味を複数層で無目的に重複検証しない。pure decisionはunit、DB固有semanticsはintegration、Discord payloadはapplication unitを基本とする。

## 2. Fake とmockの境界

- DB repository moduleやDB clientを新規に`vi.mock`しない。
- DB依存は`createTestAppContext`のfake ports、またはreal DB integrationで検証する。
- fake portsはproduction contractの写像であり、testを簡単にするためCAS、unique、dedupe、claim ownership、state transitionを緩めない。
- port interface変更時はreal/fake両方をTypeScriptで満たし、compile時にdriftを検出する。
- fake portの時刻は`AppContext.clock`から得る。
- Discord client/channel/messageのfakeは既存のtest helperへ集約し、個別testにSDK全体の二重castを散らさない。
- `vi.mock`はDiscord API helper、cron adapter、logger、HTTP/fetch等の外部boundary、またはorchestration entryの隔離に限定する。
- mockを使う場合は、何を差し替え、どのcontractを観測するかをtest名か短いcommentで明示する。

## 3. Assertion

- pure function、view model、message builder、codecは`toStrictEqual`や具体payloadを優先する。
- handler、scheduler、orchestrationは最終persisted state、user-facing response、outbox/Discord boundaryを検証する。
- raw call orderは、順序自体が業務仕様またはrace invariantの場合だけ固定する。
- `expect.any`、`objectContaining`、`arrayContaining`はSDKの非本質項目や生成ID/時刻を意図的に緩める場合だけ使う。
- skipped/no-op/race-lostは「呼ばれなかった」だけでなく、DB stateと外部副作用が変わらないことを確認する。
- Resultを返すoperationは成功値だけでなく、error code、item-level continuation、phase-level failureの境界を確認する。

## 4. Fixture とscenario

- bare `Partial<Row>`を各testへ拡散せず、業務状態が分かるbuilder/scenarioを使う。
- scenario名は、全員回答、欠席、順延OK/NG、金曜/土曜cancelled、decided/reminder、dead-letter等の業務語彙で付ける。
- stateを作るためだけの不正rowは、検証目的と破っているinvariantを明記する。
- 実行リテラルや業務仕様をfixture commentへ再記述しない。requirements、config、time、schemaを参照する。
- 仕様は`describe`/`it`名で語り、回帰理由が自明でない場合だけ`// regression:`を残す。

## 5. Race とtime

- arbitrary sleepやwall-clock待ちでraceを作らない。
- deferred promise、barrier、fake timer等の明示同期点を使う。
- 時刻は`createTestAppContext({ now })`または共通time helperで固定する。
- concurrent testはwinnerだけでなくloserのtyped result/no-opも確認する。
- Interaction snowflake fencingは古いeventが新しいResponseとaggregate revisionを変えないことを確認する。
- outbox claim expiryは旧ownerのfinalizeが失敗し、新ownerだけがDBを確定できることを確認する。
- Discord受理は二重になり得るため、exactly-once assertionを誤って置かない。

## 6. 変更種別ごとの必須テスト

| 変更 | 最低限の検証 |
|---|---|
| requirements / pure decision | decision unit、代表状態、deadline境界 |
| Interaction / command | ack順、guard失敗、success response、stale/race |
| custom ID / registry | encode/decode、malformed、duplicate/prefix conflict、stale format |
| Session aggregate | real/fake contract、lock/CAS、rollback、concurrent winner |
| outbox | dedupe、順序、claim fencing、retry/dead-letter、backfill、recovery |
| scheduler | fake clock、one-shot再構築、wake debounce、due-kind一回、supervisor fallback |
| startup/reconnect | readiness、scope別recovery、in-flight lock、debounce |
| time | JST、ISO week year、24:00、deadline、candidate、reminder |
| env/user config | valid parse、invalid fail-fast、secret非出力 |
| migration/schema consumer | momo-db check、Summit real DB integration、compatibility順序 |
| docs/agent harness | `verify:docs`、adapter一致、legacy reference不在 |

## 7. Integration test

- `INTEGRATION_DB=1` gateとlocalhost guardを維持する。
- setup/cleanupは`tests/integration/_support.ts`の共通helperを使う。
- repository、constraint、transaction、migration consumer contractに絞る。
- Discord flowでunit fakeが十分なものをreal DBへ重複させない。
- test databaseでも手動SQLで都合のよい途中状態を残さず、fixture/helperで再現可能にする。
- sibling momo-dbのmigrationを適用した状態で実行する。

## 8. Quality gate

日常の統合コマンドはpackage scriptを明示して実行する。

```bash
pnpm run ci
```

`pnpm ci`はpnpm自体のinstall系commandとして扱われるため、品質ゲートの意味では使用しない。

`pnpm run ci`はtypecheck、lint、unit test、build、forbidden-pattern、file-size advisory、documentation verificationを直列実行する。DB契約に関わる変更はintegration jobも必須とする。

baseline failureがある場合は、再現方法、変更前から失敗していた証拠、自分の変更範囲で通した検証をPRへ記録する。失敗を無関係として黙って除外しない。

## 9. テスト設計の再評価

- fakeとreal portの差分が繰り返しbugを生む場合、shared contract suiteを導入する。
- integration runtimeが日常feedbackを妨げる場合、DB testの分割・parallelismを検討する。
- test fixtureがproduction modelより複雑になった場合、scenario ownershipとbuilder層を整理する。
- call-order assertionがrefactorを頻繁に阻害する場合、state/output oracleへ置き換える。
