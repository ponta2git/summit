import type { FeatureModule } from "../../discord/registry/types.ts";
import { handlePostponeButton } from "./button.ts";
import { handlePostponeNgConfirmButton } from "./ngConfirm.ts";
import { POSTPONE_NG_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.ts";

export const postponeVotingModule: FeatureModule = {
  id: "postpone-voting",
  buttons: [
    { customIdPrefix: "postpone:", handle: handlePostponeButton },
    { customIdPrefix: POSTPONE_NG_CUSTOM_ID_PREFIX, handle: handlePostponeNgConfirmButton }
  ]
};
