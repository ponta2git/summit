process.env.TZ = "Asia/Tokyo";
import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.js";
import { members, responses, sessions } from "../../src/db/schema.js";

const CHOICE = (process.argv[2] ?? "T2230") as
  | "T2200"
  | "T2230"
  | "T2300"
  | "T2330"
  | "ABSENT";

const run = async (): Promise<void> => {
  const s = (
    await db
      .select()
      .from(sessions)
      .where(eq(sessions.status, "ASKING"))
      .orderBy(desc(sessions.createdAt))
      .limit(1)
  )[0];
  if (!s) {
    console.log("no ASKING session");
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
        choice: CHOICE,
        answeredAt: now,
      })
      .onConflictDoUpdate({
        target: [responses.sessionId, responses.memberId],
        set: { choice: CHOICE, answeredAt: now },
      });
  }
  await db
    .update(sessions)
    .set({ deadlineAt: new Date(Date.now() - 60_000), updatedAt: now })
    .where(eq(sessions.id, s.id));
  console.log(
    `Inserted ${ms.length} ${CHOICE} for session ${s.id} and expired deadline.`
  );
};

void run().finally(async () => {
  await closeDb();
});
