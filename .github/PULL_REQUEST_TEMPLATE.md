## 変更点

## 仮定

## 要確認事項

## 影響範囲

## テスト

## 運用影響（migration / env / commands:sync / deploy window）

## リスク

## 更新した仕様・設計文書

## チェックリスト

- [ ] deploy 禁止窓（金 17:30〜土 01:00 JST）外での運用を確認した
- [ ] 秘匿値（token / DATABASE_URL / DIRECT_URL）を混入していない
- [ ] `drizzle-kit push` を使用していない（generate + migrate のみ）
- [ ] `todo(ai): spec clarification needed - ...` の残置有無を明示した
- [ ] 変更対象の正本文書を確認し、必要なものを同じ PR で更新した
- [ ] `git diff --check` が pass した
- [ ] `pnpm run ci` が pass した
