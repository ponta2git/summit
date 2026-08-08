---
adr: 0055
title: tsx を削除し Node native TypeScript 実行へ移行
status: accepted
date: 2026-08-08
supersedes: []
superseded-by: null
tags: [runtime, docs, dev-tools]
---

# ADR-0055: tsx を削除し Node native TypeScript 実行へ移行

## TL;DR

Summit の開発用 TypeScript 実行を Node native type stripping と `--watch` に移行し、`tsx` を直接依存・実インストールの両方から外す。型検査と本番配布は従来どおり TypeScript compiler に分離する。

## Context

開発用 package scripts は TypeScript の直接実行と watch のために `tsx` を使用していた。一方、本番は既に `tsc` が生成した JavaScript を Node で実行しており、実行時の TypeScript 変換は開発経路だけに残っている。

Node native type stripping は Summit の `NodeNext` / ESM 構成と `erasableSyntaxOnly` の制約に適合する。ただし Node は `tsconfig.json` を実行時に読まず、既存の `.js` 相対 import を `.ts` ソースへ自動解決しないため、ソース import と build 時の拡張子変換を同時に整える必要がある。

また、pnpm の peer 自動インストールが有効な状態では、Vite の optional peer として宣言された `tsx` が direct dependency 削除後も実インストールされる。依存削除の目的を満たすには、明示宣言されていない peer の自動解決を無効にする必要がある。

## Decision

1. 開発用 TypeScript entrypoint と dev CLI は Node native type stripping で実行し、watch は Node の `--watch` を使う。
2. `src/` と `scripts/` のローカル相対 import は `.ts` を参照し、TypeScript compiler の relative import extension rewrite で build 出力を `.js` にする。
3. TypeScript の型検査は `pnpm typecheck`、本番配布物の生成は `pnpm build` が担い、Node 実行時の型検査には依存しない。
4. workspace の peer 自動インストールを無効にし、optional peer を含む開発ツールは package manifest に明示されたものだけをインストールする。
5. `tsx` は package scripts、manifest、lockfile の direct dependency、実インストールから削除する。Vite package metadata にある optional peer の宣言自体は変更しない。

## Consequences

- Node の native TypeScript は type stripping のみであり、型エラーは `pnpm typecheck` で検出する。
- ソース上のローカル import は `.ts` が正規形になる。build 出力と package runtime の import は `.js` のまま維持される。
- 既存の `tsc` build、Docker runtime、Fly process command、DB schema、業務フローは変更しない。
- peer 自動インストールを無効にしたため、将来必要な peer dependency は package manifest に明示して追加する。
- Node が native TypeScript を実行できない環境では、開発用 CLI は起動できない。Node のバージョンは repository の既存 runtime 前提に従う。

## Alternatives considered

- **tsx を維持する** — 実行時 TypeScript 依存と esbuild 経路が残るため却下。
- **compile-first の dev launcher を追加する** — `tsc --watch` と Node process の supervisor が必要になり、別の開発用実行基盤を増やすため却下。
- **ts-node / jiti へ置換する** — TypeScript 実行依存を別パッケージへ移すだけで、目的を満たさないため却下。
- **Vite の package metadata を patch して optional peer を削除する** — upstream package の peer 契約を local patch で変更する保守負債が大きいため却下。

## Re-evaluation triggers

- Node native TypeScript の仕様変更により、現行ソースの erasable syntax または ESM import が実行できなくなった場合。
- runtime code が Node native type stripping で扱えない TypeScript syntax を必要とする場合。
- Vitest / Vite の peer dependency 解決が明示依存だけでは再現不能になった場合。

## Links

- [package.json](../../package.json)
- [tsconfig.json](../../tsconfig.json)
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml)
- [Node.js TypeScript documentation](https://nodejs.org/api/typescript.html)
- [pnpm peer dependency settings](https://pnpm.io/settings/peer-dependencies)
