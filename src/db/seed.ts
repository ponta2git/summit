process.env.TZ = "Asia/Tokyo";

import { db, closeDb } from "./client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { members } from "./schema.js";

const run = async (): Promise<void> => {
  const values = env.MEMBER_USER_IDS.map((userId, index) => ({
    id: `member-${index + 1}`,
    userId
  }));

  await db.insert(members).values(values).onConflictDoNothing({
    target: members.userId
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
