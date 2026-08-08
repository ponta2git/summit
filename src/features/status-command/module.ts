import type { FeatureModule } from "../../discord/registry/types.ts";
import { statusCommandBuilder } from "./command.ts";
import { handleStatusCommand } from "./handler.ts";

export const statusCommandModule: FeatureModule = {
  id: "status-command",
  commands: [
    { name: "status", builder: statusCommandBuilder, handle: handleStatusCommand }
  ]
};
