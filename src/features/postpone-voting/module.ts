import type { FeatureModule } from "../../discord/registry/types.js";
import { handlePostponeButton } from "./button.js";
import { handlePostponeNgConfirmButton } from "./ngConfirm.js";
import { POSTPONE_NG_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.js";

export const postponeVotingModule: FeatureModule = {
  id: "postpone-voting",
  buttons: [
    { customIdPrefix: "postpone:", handle: handlePostponeButton },
    { customIdPrefix: POSTPONE_NG_CUSTOM_ID_PREFIX, handle: handlePostponeNgConfirmButton }
  ]
};
