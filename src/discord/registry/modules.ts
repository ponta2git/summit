import type { FeatureModule } from "./types.js";
import { askSessionModule } from "../../features/ask-session/module.js";
import { postponeVotingModule } from "../../features/postpone-voting/module.js";
import { cancelWeekModule } from "../../features/cancel-week/module.js";
import { statusCommandModule } from "../../features/status-command/module.js";

// why: registry に登録する feature の唯一の集約点。
// 新 feature 追加時は (1) src/features/<name>/module.ts を作成し
// (2) ここに append するだけで dispatcher / commands/definitions.ts への編集は不要 (ADR-0041)。
export const featureModules: readonly FeatureModule[] = [
  askSessionModule,
  postponeVotingModule,
  cancelWeekModule,
  statusCommandModule
];
