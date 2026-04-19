import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.js";
import * as schema from "./schema.js";

const client = postgres(env.DATABASE_URL, { max: 5, prepare: false });

export const db = drizzle(client, { schema, casing: "snake_case" });

export const closeDb = async (): Promise<void> => {
  await client.end({ timeout: 5 });
};
