import type { FeatureModule } from "../../discord/registry/types.ts";
import { ASK_ABSENT_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.ts";
import { handleAskButton } from "./button.ts";
import { handleAbsentConfirmButton } from "./absentConfirm.ts";
import { handleAskCommand } from "./command.ts";
import { askCommandBuilder } from "./definition.ts";

export const askSessionModule: FeatureModule = {
  id: "ask-session",
  buttons: [
    { customIdPrefix: "ask:", handle: handleAskButton },
    { customIdPrefix: ASK_ABSENT_CUSTOM_ID_PREFIX, handle: handleAbsentConfirmButton }
  ],
  commands: [{ name: askCommandBuilder.name, builder: askCommandBuilder, handle: handleAskCommand }]
};
