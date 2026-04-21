# TP7 Findings

**By Haiku → GPT-5.4 critique pending (R7).**

## Summary
- 判定: Medium (実質 High 1 / Medium 2 / Low/Info 若干)
- fly.toml / Dockerfile 不在 (リポに commit されていない) が最大のギャップ。README は `fly launch --no-deploy` 手順としてのみ記載

## CI inventory
- 3 jobs: static-baseline / drift-check / integration-db
- pnpm v10.33.0 pinned (package.json:10), `--frozen-lockfile` 一貫、actions/cache:pnpm OK
- Postgres service with health-check tuning (integration-db)
- 無駄: ripgrep apt-get (1-2s)、incremental TS build 未設定

## Build/runtime inventory
- package.json:8 engines.node "24.x"、packageManager "pnpm@10.33.0"
- .mise.toml: node=24.14.1 pinned、**pnpm="latest" 未 pin** (CI との drift 源)
- tsconfig: ES2023 / NodeNext / ESM。tsconfig.build.json に `incremental` なし
- .npmrc: minimum-release-age=1440 (24h)
- Drizzle flow: generate/migrate/check/reset 揃う。push 未使用 (ADR-0003)
- **fly.toml / Dockerfile: 不在** (ls 確認済、README は生成手順のみ記載)

## Findings
### F1: fly.toml / Dockerfile 不在 [High]
- ls: リポ直下に fly.toml / Dockerfile / .dockerignore なし
- README.md:deploy 節には `fly launch --no-deploy` で生成手順のみ
- 帰結: autoscale/healthcheck/memory/restart/NODE_ENV/非root の全てが SSoT 外 (Fly dashboard 管理 = drift 源)
- 単一インスタンス rule (AGENTS.md) / release_command (migrate) / デプロイ禁止窓 は repo で強制できない
- 推奨: fly.toml を commit し [deploy] release_command・auto_rollback・vm_size・min_machines_running=1 を明記

### F2: .mise.toml pnpm="latest" 未 pin [High]
- .mise.toml:3 が unpin、CI は package.json で 10.33.0 固定
- ローカル `mise install` で v11 に上がると lockfile 互換崩れの可能性
- 推奨: `pnpm = "10.33.0"` に固定

### F3: tsconfig.build.json incremental 未設定 [Low]
- dev loop 0.5-1s のロス、CI 影響は小

### F4: pnpm.onlyBuiltDependencies は esbuild のみ [Info]
- prod-only install hint なし、fly.toml 不在と組み合わさって runtime image size 未統制

## 起動コスト (src/index.ts)
- reconcileMembers → login → scheduler init の順、long sync なし
- 大きな crypto/JSON parse なし
- 推定 cold start ~5-10s (妥当)

## Unknown (fly.toml 不在に起因)
- VM size / autoscale / healthcheck / restart policy / 非 root / NODE_ENV=production
- 多段ビルド / prod 依存プルーニング

## TP4 / TP1 F5 との関連
- 本 review では healthcheck 観点は TP4/TP1 F5 (ping 実装欠落) と独立だが、fly.toml 不在で Fly 側 healthcheck も SSoT 外
