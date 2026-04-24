import type { FeatureModule } from "../../discord/registry/types.js";
import { handlePostponeButton } from "./button.js";

export const postponeVotingModule: FeatureModule = {
  id: "postpone-voting",
  buttons: [{ customIdPrefix: "postpone:", handle: handlePostponeButton }]
};
