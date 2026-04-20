import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbLike } from "../../src/db/rows.js";
import { reconcileMembers } from "../../src/members/reconcile.js";
import type { MemberReconcileInput } from "../../src/members/inputs.js";

// why: DB 操作を stub し、reconcileMembers のロジック（upsert 判定・ログ出力）を検証する。
vi.mock("../../src/db/schema.js", () => ({
  members: {
    id: "id",
    userId: "user_id",
    displayName: "display_name",
    createdAt: "created_at"
  }
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

const MEMBERS: ReadonlyArray<MemberReconcileInput> = [
  {
    userId: "323456789012345678",
    displayName: "いーゆー",
    syncDisplayName: false
  },
  {
    userId: "423456789012345678",
    displayName: "おーたか",
    syncDisplayName: false
  },
  {
    userId: "523456789012345678",
    displayName: "あかねまみ",
    syncDisplayName: false
  },
  {
    userId: "623456789012345678",
    displayName: "ぽんた",
    syncDisplayName: false
  }
];

const buildMockDb = (existingRows: { id: string; userId: string; displayName: string }[]) => {
  const selectResult = {
    from: vi.fn().mockResolvedValue(existingRows)
  };
  const insertResult = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined)
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateResult = {
    set: vi.fn().mockReturnValue({
      where: updateWhere
    })
  };
  const db = {
    select: vi.fn().mockReturnValue(selectResult),
    insert: vi.fn().mockReturnValue(insertResult),
    update: vi.fn().mockReturnValue(updateResult)
  } as unknown as DbLike;

  return { db, selectResult, insertResult, updateResult, updateWhere };
};

describe("reconcileMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts all 4 IDs when the members table is empty", async () => {
    const { db, insertResult } = buildMockDb([]);

    await reconcileMembers(MEMBERS, db);

    expect(insertResult.values).toHaveBeenCalledWith(
      MEMBERS.map((member, index) => ({
        id: `member-${index + 1}`,
        userId: member.userId,
        displayName: member.displayName
      }))
    );
    expect(insertResult.onConflictDoNothing).toHaveBeenCalled();
  });

  it("inserts only missing IDs when some members already exist", async () => {
    const existingRows = [
      { id: "member-1", userId: MEMBERS[0]!.userId, displayName: MEMBERS[0]!.displayName },
      { id: "member-2", userId: MEMBERS[1]!.userId, displayName: MEMBERS[1]!.displayName }
    ];
    const { db, insertResult } = buildMockDb(existingRows);

    await reconcileMembers(MEMBERS, db);

    // invariant: 新規 ID のみ insert し、既存 ID には触らない
    expect(insertResult.values).toHaveBeenCalledWith([
      { id: "member-3", userId: MEMBERS[2]!.userId, displayName: MEMBERS[2]!.displayName },
      { id: "member-4", userId: MEMBERS[3]!.userId, displayName: MEMBERS[3]!.displayName }
    ]);
  });

  it("performs no insert when all members are already present", async () => {
    const existingRows = MEMBERS.map((member, index) => ({
      id: `member-${index + 1}`,
      userId: member.userId,
      displayName: member.displayName
    }));
    const { db, insertResult } = buildMockDb(existingRows);

    await reconcileMembers(MEMBERS, db);

    // idempotent: 全員が既に存在する場合、insert は呼ばれない
    expect(insertResult.values).not.toHaveBeenCalled();
  });

  it("updates display_name when syncDisplayName is true", async () => {
    const existingRows = [
      { id: "member-1", userId: MEMBERS[0]!.userId, displayName: "旧名" }
    ];
    const { db, updateResult, updateWhere } = buildMockDb(existingRows);

    await reconcileMembers(
      [
        {
          userId: MEMBERS[0]!.userId,
          displayName: MEMBERS[0]!.displayName,
          syncDisplayName: true
        }
      ],
      db
    );

    expect(updateResult.set).toHaveBeenCalledWith({
      displayName: MEMBERS[0]!.displayName
    });
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it("does not update display_name when syncDisplayName is false", async () => {
    const existingRows = [
      { id: "member-1", userId: MEMBERS[0]!.userId, displayName: "旧名" }
    ];
    const { db, updateResult } = buildMockDb(existingRows);

    await reconcileMembers(
      [
        {
          userId: MEMBERS[0]!.userId,
          displayName: MEMBERS[0]!.displayName,
          syncDisplayName: false
        }
      ],
      db
    );

    expect(updateResult.set).not.toHaveBeenCalled();
  });

  it("logs added and existing members", async () => {
    const { logger } = await import("../../src/logger.js");
    const existingRows = [{ id: "member-1", userId: MEMBERS[0]!.userId, displayName: MEMBERS[0]!.displayName }];
    const { db } = buildMockDb(existingRows);

    await reconcileMembers(MEMBERS, db);

    expect(logger.info).toHaveBeenCalledWith(
      {
        inserted: [MEMBERS[1]!.userId, MEMBERS[2]!.userId, MEMBERS[3]!.userId],
        existing: [MEMBERS[0]!.userId],
        displayNameUpdated: []
      },
      "Members reconciled with env"
    );
  });
});
