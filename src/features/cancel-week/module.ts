import type { FeatureModule } from "../../discord/registry/types.ts";
import { CANCEL_WEEK_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.ts";
import { handleCancelWeekButton } from "./button.ts";
import { handleCancelWeekCommand } from "./command.ts";
import { cancelWeekCommandBuilder } from "./definition.ts";

export const cancelWeekModule: FeatureModule = {
  id: "cancel-week",
  buttons: [{ customIdPrefix: CANCEL_WEEK_CUSTOM_ID_PREFIX, handle: handleCancelWeekButton }],
  commands: [
    { name: cancelWeekCommandBuilder.name, builder: cancelWeekCommandBuilder, handle: handleCancelWeekCommand }
  ]
};
