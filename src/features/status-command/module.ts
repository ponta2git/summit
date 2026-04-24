import type { FeatureModule } from "../../discord/registry/types.js";
import { statusCommandBuilder } from "./command.js";
import { handleStatusCommand } from "./handler.js";

export const statusCommandModule: FeatureModule = {
  id: "status-command",
  commands: [
    { name: "status", builder: statusCommandBuilder, handle: handleStatusCommand }
  ]
};
