import { inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { members } from "../../src/db/schema.ts";
import { reconcileMembers } from "../../src/members/reconcile.ts";
import { createIntegrationDb } from "./_support.ts";

const existingMembers = [
  { id: "member-1", userId: "333333333333333333", displayName: "Existing one" },
  { id: "member-2", userId: "444444444444444444", displayName: "Existing two" },
  { id: "member-3", userId: "555555555555555555", displayName: "Existing three" },
  { id: "member-4", userId: "666666666666666666", displayName: "Existing four" }
];

describe("member identity reconciliation (integration)", () => {
  const { db } = createIntegrationDb();
  const userIds = [...existingMembers.map(member => member.userId), "777777777777777777"];
  const findFixtureMembers = () => db.select().from(members).where(inArray(members.userId, userIds));
  beforeEach(async () => {
    await db.delete(members).where(inArray(members.userId, userIds));
    await db.insert(members).values(existingMembers);
  });

  it("adds a replacement without reusing the retained member's identity", async () => {
    const replacement = { userId: "777777777777777777", displayName: "New member", syncDisplayName: true };
    const inputs = [replacement, ...existingMembers.slice(1).map(member => ({ ...member, syncDisplayName: true }))];
    await reconcileMembers(inputs, db);
    const first = await findFixtureMembers();
    expect(first).toHaveLength(5);
    expect(first.find(member => member.userId === replacement.userId)).toMatchObject({ displayName: "New member" });
    expect(first.find(member => member.userId === replacement.userId)?.id).not.toBe("member-1");
    expect(first.find(member => member.id === "member-1")).toMatchObject(existingMembers[0]!);
    await reconcileMembers([...inputs].reverse(), db);
    expect((await findFixtureMembers()).sort((a, b) => a.id.localeCompare(b.id)))
      .toStrictEqual(first.sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("updates explicit names and preserves DB-owned names and existing IDs", async () => {
    await reconcileMembers([
      { userId: "333333333333333333", displayName: "Renamed", syncDisplayName: true },
      { userId: "444444444444444444", displayName: "Ignored", syncDisplayName: false }
    ], db);
    const rows = await findFixtureMembers();
    expect(rows.find(member => member.id === "member-1")).toMatchObject({ displayName: "Renamed" });
    expect(rows.find(member => member.id === "member-2")).toMatchObject(existingMembers[1]!);
    expect(rows).toHaveLength(4);
  });

  it("rolls back earlier name changes when a later insert is rejected", async () => {
    const before = await findFixtureMembers();
    // invariant: DBのname長制約違反を注入し、既存行の更新まで一括で戻ることを確認する。
    await expect(reconcileMembers([
      { userId: "333333333333333333", displayName: "Must roll back", syncDisplayName: true },
      { userId: "777777777777777777", displayName: "x".repeat(33), syncDisplayName: true }
    ], db)).rejects.toMatchObject({ cause: { code: "22001" } });
    expect((await findFixtureMembers()).sort((a, b) => a.id.localeCompare(b.id)))
      .toStrictEqual(before.sort((a, b) => a.id.localeCompare(b.id)));
  });
});
