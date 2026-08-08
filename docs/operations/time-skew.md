# Time Skew SOP

サーバ clock (Fly host の時計) が JST 基準時刻から大きくずれた場合の運用手順。時刻契約は `docs/time-rule.md` を正本とし、本ファイルは運用者視点の SOP のみを扱う。

## 前提

- Summit は Fly host の NTP 同期を信頼する (独自 NTP query 無し)
- 時刻依存ロジックは `src/time/` と注入された `Clock` 経由で JST 解釈される
- production code で現在時刻を得るときは `ctx.clock` / `systemClock` の定義済み境界を使う

## 検知

### Primary: `/status` の `now` 表示

Discord で `/status` を実行 → 応答の `now` フィールドが現在の JST 時刻と数十秒以上ずれていないか目視確認。

### Secondary: outbox metrics の違和感

`event=outbox.metrics` の `oldestPendingAgeMs` が負値 / 異常に大きい値になる場合は skew を疑う (age は `now - created_at` で計算されるため)。

## skew 規模別 SOP

skew の規模ごとの挙動と対応:

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

**禁止窓チェック**: 金 17:30〜土 01:00 JST に該当する場合は restart しない。`/status` と logs で影響を記録し、禁止窓終了後に再確認して実施する。禁止窓中の例外判断が必要なインシデントは、この runbook では権限を拡張せず運用責任者へ escalation する。

## 取りこぼし防止の設計 (参考)

自動復旧が効く理由 (詳細は `docs/architecture.md` と `docs/db-rule.md`):

- **reconciler invariants**: 未投稿の金曜募集 / 締切超過の session を次の回復経路で再収束
- **Session aggregate command**: Session lock 後の同一 snapshot で締切判定と遷移を確定する
- **ordered outbox at-least-once**: 表示遅延や重複はあり得るが、必須投稿の欠落と順序逆転を抑止する
- **`(weekKey, postpone_count)` unique**: 週キーが誤算定されても同一週キーで重複 session が作れない

## 自動検知を実装しない理由

起動時 NTP query / tick 相対 skew 監視 / PostgreSQL `now()` の時刻正本化は、現在の規模では追加の障害点と複数時刻源を生むため採用しない。複数 host の clock drift が実際に観測される、または provider の時刻同期保証が変わった場合は `docs/time-rule.md` の再評価条件に従って再検討する。

## 実施後のフォロー

- `fly logs` で `phase=ready` を確認
- `/status` で `now` が正しい JST を返すか再確認
- outbox metrics が平常値に戻るか 5 分観測
- 異常値が継続するなら [recovery.md](./recovery.md) の復旧不能ケース A (DB 破損) を疑い [backup.md](./backup.md) を参照
