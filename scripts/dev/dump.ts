process.env.TZ = "Asia/Tokyo";
import { closeDb, db } from "../../src/db/client.js";
import { members, responses } from "../../src/db/schema.js";

const run = async (): Promise<void> => {
  const ms = await db.select().from(members);
  console.log("members:", ms.length);
  for (const m of ms) console.log(" ", m.id, m.userId, m.displayName);
  const rs = await db.select().from(responses);
  console.log("responses:", rs.length);
  for (const r of rs) console.log(" ", r.sessionId.slice(0, 8), r.memberId, r.choice);
};

void run().finally(async () => {
  await closeDb();
});
