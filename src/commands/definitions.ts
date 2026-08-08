import { buildFeatureRegistry } from "../discord/registry/index.ts";
import { featureModules } from "../discord/registry/modules.ts";

// why: SlashCommandBuilder の SSoT は各 feature の module.ts。
// definitions.ts は registry を一度 build して toJSON() 配列を作るだけの薄い層。
// 新 feature 追加でこのファイルの編集は不要。
const registry = buildFeatureRegistry(featureModules);

const commandBuilders = registry.slashBuilders;

export const slashCommands = commandBuilders.map((command) => command.toJSON());
