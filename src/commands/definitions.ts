import { askCommandBuilder } from "../features/ask-session/definition.ts";
import { cancelWeekCommandBuilder } from "../features/cancel-week/definition.ts";
import { statusCommandBuilder } from "../features/status-command/command.ts";

// invariant: 同期は定義だけを読む。実行用 registry / handler / Bot 設定へ依存しない。
// source-of-truth: payload は feature 所有。実行用 registry との一覧一致は test で確認する。
const commandBuilders = [askCommandBuilder, cancelWeekCommandBuilder, statusCommandBuilder];

export const slashCommands = commandBuilders.map((command) => command.toJSON());
