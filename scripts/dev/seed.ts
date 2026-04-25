// jst: seed は env.ts より先に import される可能性があるため、明示的に TZ を固定する。
//   env.ts 側は ??= だが、こちらは絶対値で上書きして CI / ローカル環境の揺れを防ぐ。
process.env.TZ = "Asia/Tokyo";

import { sql } from "drizzle-orm";

import { db, closeDb } from "../../src/db/client.js";
import { logger } from "../../src/logger.js";
import { buildMemberReconcileInputs } from "../../src/members/inputs.js";
import { members } from "../../src/db/schema.js";
import { appConfig } from "../../src/userConfig.js";

const run = async (): Promise<void> => {
  // invariant: member.id = "member-{index+1}" は固定順序。userId 側は user config の members 順に追従。
  //   id 不変性を保つことで responses.memberId の整合を保つ。
  const values = buildMemberReconcileInputs(
    appConfig.memberUserIds,
    appConfig.memberDisplayNames
  ).map((member, index) => ({
    id: `member-${index + 1}`,
    userId: member.userId,
    displayName: member.displayName
  }));

  // idempotent: member.id を target にした upsert で再 seed 可能。userId が変更された場合も追従する。
  await db
    .insert(members)
    .values(values)
    .onConflictDoUpdate({
      target: members.id,
      set: {
        userId: sql`excluded.user_id`,
        displayName: sql`excluded.display_name`
      }
    });

  logger.info(
    {
      memberCount: values.length
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
