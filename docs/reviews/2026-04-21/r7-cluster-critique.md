# R7 Critical Cluster Critique (by GPT-5.4)

| Cluster | Verdict | Critique |
|---|---|---|
| C1 CANCELLED 宙づり | **Critical** | 足し算でなく仕様違反+自動回復不能。仕様 (requirements/base.md:227-233,269-275) は CANCELLED を一時状態扱い、実装/回復は長寿命許容 (TA5/TA6, scheduler/index.ts:166-209)、Friday cancel→postpone split update で stranded (TS4 F1, TP5 F2)。**週が止まる**→ Critical 妥当。修正: 長寿命 CANCELLED 廃止 / edge-specific transition / Friday path atomic |
| C2 reminder stuck | High-keep | ADR-0024 が既知残余リスク受容明記 (docs/adr/0024-reminder-dispatch.md:42-45)。レビュー結論は「受容条件 + 補償策不足」追記: stale-claim detector / warn / manual runbook / reclaim 条件。**cluster membership 訂正: TA6 F4 は test gap であり本体欠陥ではない**、実体は TP3 F1 + TA5 F3 |
| C3 restart 窓跨ぎ ask 消失 | High-keep | TA1/TA6 が埋めない理由は両者とも「既存 non-terminal session の再処理」のみで**未作成 ask を補完しない** (TP1 F2, TA1, scheduler/index.ts:166-209)。さらに ask publish 自体が create→send→messageId split で row あっても message 無い穴 (TS4 F2, TP5 F3, features/ask-session/send.ts:77-118) |
| C4 ready log / ping / healthcheck | High-keep | **1 Critical に束ねるのは過大**。修正は分離可能 (TP1 F1 ready / TP1 F5+TP4 F1 ping / TP7 F1 Fly SSoT)。正しさを直ちに壊すのは C1/C3 ほどではない |
| C5 CI / supply chain | High-keep (trim) | **TS5 F1 (permissions 未明示) のみ High 維持**。repo 規模関係なく token default 権限依存は危険。action SHA 未固定 (TS5 F2) と .mise.toml pnpm unpin (TP7 F2) は **Medium 相当**に下げる |
| C6 test determinism / DI | Downgrade (→ Medium 統合維持) | Low まで落とさない。ADR-0018 の狙い (fake/real semantics 一致) を弱める意味で Medium。ただし production blocker ではない |

## New cluster detected
**N1 ask publication/recovery gap = near-Critical**
- 根: 週次 ask publish に durable recovery なし
- 構成: TP1 F2 + TS4 F2 + TP5 F3
- User impact (週の募集消失) は C1 に次ぐ

## Residual Medium/Low
- TA2/TA7 依存循環・ingress 責務揺れ: Medium 維持
- TS2 nested error redact / raw error: Medium 維持
- TP6 429 無観測: Medium 維持
- TA8/TP2 time/test gap: Low 維持

## Suggested fix sequencing
1. **Invariant-based startup reconciler** (stranded CANCELLED / stale reminder claim / missing ask / null messageId を一括修復)
2. `transitionStatus` 廃止 → **edge-specific state API + non-terminal 再定義**
3. Friday cancel→postpone と ask publish を **atomic** 化 (tx/outbox/recovery marker)
4. ready contract / ping / fly.toml を揃えて観測性 SSoT 化
5. CI hardening (permissions 明示 → SHA pin → pnpm pin) → C6 deterministic test 改善

## Contradictions
- **実質矛盾なし**
- 見かけ上: TA5 F1 (High) vs TS4 F1 (Medium) は同一現象の別評価でなく、前者=仕様破綻 / 後者=機構要因
- **訂正**: C2 cluster に TA6 F4 を入れるのは不正確
