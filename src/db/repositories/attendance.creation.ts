import { sql } from "drizzle-orm";
import type { DbTransaction } from "../transaction.ts";

/** Admission is global to this Bot, including across week boundaries. */
export const lockAttendanceCreation = async (tx: DbTransaction): Promise<void> => {
  // Separate from result (1) and attendance delivery (2). Never acquire it after the delivery gate.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(19790514, 3)`);
};
