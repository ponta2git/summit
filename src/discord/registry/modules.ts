import type { FeatureModule } from "./types.ts";
import { askSessionModule } from "../../features/ask-session/module.ts";
import { postponeVotingModule } from "../../features/postpone-voting/module.ts";
import { cancelWeekModule } from "../../features/cancel-week/module.ts";
import { statusCommandModule } from "../../features/status-command/module.ts";

// why: 実行用 feature の集約点。slash command の追加時は commands/definitions.ts にも
// handler 非依存の定義を登録する。payload の正本は各 feature で共有する。
export const featureModules: readonly FeatureModule[] = [
  askSessionModule,
  postponeVotingModule,
  cancelWeekModule,
  statusCommandModule
];
