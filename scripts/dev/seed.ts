// jst: seed は env.ts より先に import される可能性があるため、明示的に TZ を固定する。
//   env.ts 側は ??= だが、こちらは絶対値で上書きして CI / ローカル環境の揺れを防ぐ。
process.env["TZ"] = "Asia/Tokyo";

import { db, closeDb } from "../../src/db/client.ts";
import { logger } from "../../src/logger.ts";
import { buildMemberReconcileInputs } from "../../src/members/inputs.ts";
import { reconcileMembers } from "../../src/members/reconcile.ts";
import { appConfig } from "../../src/userConfig.ts";
import { env } from "../../src/env.ts";
import { assertLocalDatabase } from "./localDatabase.ts";

const run = async (): Promise<void> => {
  assertLocalDatabase(env.DATABASE_URL);
  const inputs = buildMemberReconcileInputs(appConfig.memberUserIds, appConfig.memberDisplayNames);
  await reconcileMembers(inputs, db);

  logger.info(
    {
      memberCount: inputs.length
    },
    "Seed completed."
  );
};

void run()
  .catch((error: unknown) => {
    logger.error({ error }, "Seed failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
