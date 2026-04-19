## 変更点

## 仮定

## 要確認事項

## 影響範囲

## テスト

## 運用影響（migration / env / commands:sync / deploy window）

## リスク

## チェックリスト
- [ ] deploy 禁止窓（金 17:30〜土 01:00 JST）外での運用を確認した
- [ ] 秘匿値（token / DATABASE_URL / DIRECT_URL / HEALTHCHECK_PING_URL）を混入していない
- [ ] `drizzle-kit push` を使用していない（generate + migrate のみ）
- [ ] `TODO(ai): spec clarification needed - ...` の残置有無を明示した
- [ ] `requirements/base.md` の該当 § を本文に明記した
- [ ] `pnpm verify:forbidden` が pass した
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` / `pnpm db:check` が pass した
