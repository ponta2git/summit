# AGENTS.md

## 1. 文書マップ

**必要な文書だけを読む。全ドキュメントを事前に一括で読まない。分析済みの内容は再利用し、不要な文書の再読はしない。**
最初に`docs/README.md`を見て、変更対象に必要なrequirements・設計文書・runbookだけを選ぶ。

---

## 2. 機密・破壊境界

- secret、token、接続文字列、Authorization等の実値をdocs、code、fixture、log、PR、Issue、commit、chatへ出さない
- `.env.local`等のgit管理外設定は、ユーザーが明示し作業上必要な場合だけ読む。値を回答や成果物へ転記しない
- productionのdata、secret、topology、deploy状態を変える操作は、該当runbookと明示的な実行権限が揃うまで行わない
- production破壊、不可逆なsecret変更、単一instance前提、deploy禁止窓に関する不明点や文書矛盾があれば即時停止する

---

## 3. 制約

- 事実と推測・提案を峻別して伝える
- 不明な場合はごまかさず、不明であることを明示する
- 仕様の矛盾・穴、スコープ拡大、規約を超える設計判断が必要な場合は停止し、ユーザーに確認する
- 業務仕様を推測で補わない。仕様未確定時の処理は`docs/README.md`に従う
- 提案時は、理由・リスク・次のステップを併せて示す
- AIによる確率論的推論とscript/programによる決定論的検証を使い分け、検証可能なものは可能な限り決定論的に確認する

---

## 4. 探索・計画の基本原則

- 最初に対象領域を絞り、`docs/README.md`の読む条件に一致する文書、code、testだけを調べる
- 観点を自分で包括的に生成し、特に見落としやすいfailure、race、recovery、運用境界を反芻する
- 依存関係と優先度を判断し、実施順序・説明順序を決める。重要性、リスク、推奨対応を含める
- 文書の記述だけで断定せず、必要な範囲で実装・設定・testと照合する

---

## 5. 実装時の基本原則

- 必ず仕様を満たす実装を行う。理由、不明点、矛盾、穴を調べ、解消できないまま実装しない
- 場当たり的な症状対応を避け、正本と不変条件に沿った本質的な変更を行う
- 選択した設計文書の規則に従い、設計上の不変条件を変える場合は同じ変更でliving documentも更新する
- 文書体系・正本・設計判断の更新方法は`docs/README.md`に従う
- 変更リスクに応じたquality gateを適切なタイミングで通す。commandとtest選択は`docs/dev-rule.md`と`docs/test-rule.md`を正本とする
- production operationは該当する`docs/operations/`のrunbookに従う

---

## 6. 完了条件

- 実装が仕様を満たしている
- requirements、設計文書、code、testが同じcontractを示している
- 変更に応じたquality gateが通っている
- 主要なfailure、race、recovery caseが考慮・検証されている
- secret露出、production破壊、運用禁止事項への違反がない
- 未解決事項、置いた仮定、baseline failureを明示している
