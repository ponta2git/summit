# Time Skew SOP

サーバ clock (Fly host の時計) が JST 基準時刻から大きくずれた場合の運用手順。契約と設計根拠は **ADR-0044** に集約、本ファイルは運用者視点の SOP のみを扱う。

## 前提

- Summit は Fly host の NTP 同期を信頼する (独自 NTP query 無し、ADR-0044)
- 時刻依存ロジックはすべて `src/time/` 経由で JST 解釈される (ADR-0002)
- `new Date()` を `src/time/` 外で使うことは禁止 (`.github/instructions/time-review.instructions.md`)

## 検知

### Primary: `/status` の `now` 表示

Discord で `/status` を実行 → 応答の `now` フィールドが現在の JST 時刻と数十秒以上ずれていないか目視確認。

### Secondary: outbox metrics の違和感

`event=outbox.metrics` の `oldestPendingAgeMs` が負値 / 異常に大きい値になる場合は skew を疑う (age は `now - created_at` で計算されるため)。

## skew 規模別 SOP

ADR-0044 の挙動表と対応:

| skew 規模 | 業務影響 | SOP |
|---|---|---|
| < 1 min | なし (cron の schedule 精度内) | 何もしない |
| 1〜10 min | 金曜朝の募集投稿がわずかに遅れる程度 / DB 整合は保たれる | Fly machine restart で NTP 再同期を促す |
| 10〜30 min | 締切判定が実時間と乖離、但し取りこぼしは起きない (reconciler B/E が次 tick で収束) | 即 `fly machine restart` |
| > 30 min | ISO week 跨ぎ等で週キー誤算定のリスクが高まる | `fly machine restart` → 復旧しなければ `fly apps restart summit` → 直らなければ Fly support に報告 |

### `fly machine restart` 手順

```bash
fly machine list -a summit-momotetsu
fly machine restart <machine_id> -a summit-momotetsu
```

**禁止窓チェック**: 金 17:30〜土 01:00 JST に該当する場合は原則実施しない。ただし **週キー破綻リスクが高い大 skew 発生時は例外的に実施** (AGENTS.md の deploy 禁止窓は「deploy / restart / schema 変更を提案・実行しない」とあるが、skew が業務影響を出しているなら放置するほうがリスクが高い)。実施した場合は事後に PR で経緯を記録する。

## 取りこぼし防止の設計 (参考)

自動復旧が効く理由 (詳細は ADR-0044):

- **reconciler invariant B/E**: 未投稿の金曜募集 / 締切超過の session を次 tick で再収束 (ADR-0033)
- **CAS-on-NULL**: 締切書き込みは CAS のため、skew 中に誤った時刻で書かれても実時刻復旧後に上書きされない (ADR-0024)
- **outbox at-least-once**: 表示遅延はあっても喪失なし (ADR-0035)
- **`(weekKey, postpone_count)` unique**: 週キーが誤算定されても同一週キーで重複 session が作れない (ADR-0009)

## 自動検知を実装しない理由

ADR-0044 §Alternatives A/B/C で代替案 (起動時 NTP query / tick 相対 skew 監視 / postgres `now()` SSoT) を却下した経緯を参照。再評価 trigger が満たされたら再検討する。

## 実施後のフォロー

- `fly logs` で `phase=ready` を確認
- `/status` で `now` が正しい JST を返すか再確認
- outbox metrics が平常値に戻るか 5 分観測
- 異常値が継続するなら [recovery.md](./recovery.md) の復旧不能ケース A (DB 破損) を疑い [backup.md](./backup.md) を参照
