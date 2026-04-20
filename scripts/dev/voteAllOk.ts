process.env.TZ = "Asia/Tokyo";
import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.js";
import { members, responses, sessions } from "../../src/db/schema.js";

const run = async (): Promise<void> => {
  const s = (
    await db
      .select()
      .from(sessions)
      .where(eq(sessions.status, "POSTPONE_VOTING"))
      .orderBy(desc(sessions.createdAt))
      .limit(1)
  )[0];
  if (!s) {
    console.log("no POSTPONE_VOTING session");
    return;
  }
  const ms = await db.select().from(members);
  const now = new Date();
  for (const m of ms) {
    await db
      .insert(responses)
      .values({
        id: randomUUID(),
        sessionId: s.id,
        memberId: m.id,
        choice: "POSTPONE_OK",
        answeredAt: now,
      })
      .onConflictDoUpdate({
        target: [responses.sessionId, responses.memberId],
        set: { choice: "POSTPONE_OK", answeredAt: now },
      });
  }
  await db
    .update(sessions)
    .set({ deadlineAt: new Date(Date.now() - 60_000), updatedAt: now })
    .where(eq(sessions.id, s.id));
  console.log(
    `Inserted ${ms.length} POSTPONE_OK for session ${s.id} and expired deadline.`
  );
};

void run().finally(async () => {
  await closeDb();
});
