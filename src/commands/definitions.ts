import { buildFeatureRegistry } from "../discord/registry/index.js";
import { featureModules } from "../discord/registry/modules.js";

// why: SlashCommandBuilder の SSoT は各 feature の module.ts。
// definitions.ts は registry を一度 build して toJSON() 配列を作るだけの薄い層。
// 新 feature 追加でこのファイルの編集は不要 (ADR-0041)。
const registry = buildFeatureRegistry(featureModules);

export const commandBuilders = registry.slashBuilders;

export const slashCommands = commandBuilders.map((command) => command.toJSON());
