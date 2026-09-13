import { describe, expect, it } from "vitest";

import { computeMemberReconcilePlan } from "../../src/members/reconcile.ts";
import type { MemberReconcileInput } from "../../src/members/inputs.ts";

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

describe("computeMemberReconcilePlan", () => {
  it("builds an immutable diff for inserts, existing rows, and display name updates", () => {
    const plan = computeMemberReconcilePlan(
      [
        { ...MEMBERS[0]!, syncDisplayName: true },
        { ...MEMBERS[1]!, syncDisplayName: true },
        MEMBERS[2]!
      ],
      [
        { id: "member-1", userId: MEMBERS[0]!.userId, displayName: "旧名" },
        { id: "member-2", userId: MEMBERS[1]!.userId, displayName: MEMBERS[1]!.displayName }
      ]
    );

    expect(plan).toStrictEqual({
      rowsToInsert: [
        { userId: MEMBERS[2]!.userId, displayName: MEMBERS[2]!.displayName }
      ],
      displayNameUpdates: [
        { userId: MEMBERS[0]!.userId, displayName: MEMBERS[0]!.displayName }
      ],
      alreadyPresent: [MEMBERS[0]!.userId, MEMBERS[1]!.userId]
    });
  });
});
