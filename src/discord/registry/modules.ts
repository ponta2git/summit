import type { FeatureModule } from "./types.js";

// why: registry に登録する feature の唯一の集約点。
// 新 feature 追加時は (1) src/features/<name>/module.ts を作成し
// (2) ここに append するだけで dispatcher / commands/definitions.ts への編集は不要 (ADR-0041)。
export const featureModules: readonly FeatureModule[] = [];
