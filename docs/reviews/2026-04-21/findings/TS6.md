# TS6 Findings

**By Haiku → GPT-5.4 critique pending (R7).**

## Summary
- 判定: Compliant (Critical/High/Medium/Low = 0/0/0/0)
- 宣言・参照・redact・rotation・CI・script の 9 checks すべてクリア
- TS1/TS2/TS5 の結果とも整合

## Secret matrix
| secret | declared | used | redacted | rotation |
| DISCORD_TOKEN | .env.example | src/index.ts:70 / commands/sync.ts:26 | pino redact | Discord再発行 |
| DATABASE_URL | .env.example | src/db/client.ts:9 / env.ts:47 | pino redact | fly secrets set |
| DIRECT_URL | .env.example | drizzle.config.ts:17 のみ | pino redact | fly secrets set |
| HEALTHCHECK_PING_URL | .env.example | env.ts:54 (optional) | pino redact | fly secrets set |
| FLY_API_TOKEN | CI secret のみ | fly deploy (手動/未CI) | N/A | fly tokens create deploy + revoke |

## Task results
1. Secret reference census: 実値ゼロ、placeholder のみ
2. .env.example hygiene: `replace-with-bot-token`, `postgres://summit:summit@localhost` 等プレースホルダ
3. .gitignore: `.env.local`, `.env` 網羅
4. Git history: Discord token regex・Neon URL 共に 0 件 (past commits もクリーン)
5. DIRECT_URL confinement: src/** は logger redact 宣言のみで drizzle.config.ts 以外に参照なし ✅
6. CI: `.github/workflows/ci.yml` に FLY_API_TOKEN 参照なし (deploy は CI 外)、integration DB は localhost credential のみ
7. Logger redact: DATABASE_URL/DIRECT_URL/HEALTHCHECK_PING_URL/DISCORD_TOKEN + env.* variants カバー、remove:true
8. Rotation docs: ADR-0005:37-67 + README に app-scoped deploy token / revoke+reissue 手順記載
9. scripts/dev/*.ts: console.log で secret 吐かない、reset.ts/scenario.ts は DATABASE_URL host=localhost で guard

## 補足 checks
- `as any`/`@ts-ignore` 禁止: forbidden-patterns.sh rule 5
- `src/**` で `process.env.DIRECT_URL` 不在: rule 6
- `src/**` で console.log 不在: rule 1
- Discord token shape 正規表現が全 tracked file を scan: rule 8
- drizzle-kit push 不在: rule 4

## Unknown
- GitHub Actions Secrets の実効内容 (Personal Auth Token が混入していないか) は repo 外
- Healthchecks.io ping URL の実運用ログ (redact 網はあるが運用規律依存)

## TS2 との重なり
- TS2 Medium (redact パス網羅不足) は `env.*` variant は OK だが **エラーオブジェクト配下** 等 nested path は未整理
- 本 TS6 は宣言側の compliance のみ確認、TS2 指摘は独立に有効
