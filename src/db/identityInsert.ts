import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DbLike } from "./rows.ts";
import type { IdentityLayout } from "./identities.ts";

/**
 * Use shared-schema encoders for both layouts. The legacy build has no legacy_id
 * property, so only this narrow INSERT boundary adds that contract column.
 */
export const insertIdentity = async <T extends PgTable>(
  tx: Pick<DbLike, "execute">, layout: IdentityLayout, table: T,
  values: { readonly [K in keyof T["$inferInsert"]]?: T["$inferInsert"][K] | SQL },
  conflict: SQL
): Promise<boolean> => {
  const columns = getTableColumns(table);
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  const names: SQL[] = [];
  const parameters: SQL[] = [];
  for (const [property, value] of entries) {
    const column = columns[property];
    if (!column) { throw new Error("Unknown identity insert column"); }
    names.push(sql`${sql.identifier(column.name)}`);
    parameters.push(is(value, SQL) ? value : sql`${sql.param(value, column)}`);
    if (property === "id" && layout === "canonical_uuid") {
      // New ordinary entities arrive with a UUID generated once by the caller.
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
        throw new Error("New canonical entity requires a standard UUID");
      }
      names.push(sql`legacy_id`);
      parameters.push(sql`${value}`);
    }
  }
  const rows = await tx.execute<{ id: string }>(sql`INSERT INTO ${table} (${sql.join(names, sql`, `)})
    VALUES (${sql.join(parameters, sql`, `)}) ${conflict} RETURNING id`);
  return rows.length > 0;
};
