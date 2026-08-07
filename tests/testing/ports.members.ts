import type { MemberRow, MembersPort } from "../../src/db/ports.js";
import { makeMember } from "./fixtures.js";
import { recordCall, type AnyCall } from "./ports.shared.js";

export interface FakeMembersPort extends MembersPort {
  readonly calls: ReadonlyArray<AnyCall>;
}

export const createFakeMembersPort = (
  seed: ReadonlyArray<MemberRow> = []
): FakeMembersPort => {
  const calls: AnyCall[] = [];
  const members = seed.map((member) => makeMember(member));
  return {
    calls,
    findMemberIdByUserId: async (userId) => {
      recordCall(calls, "findMemberIdByUserId", { userId });
      return members.find((member) => member.userId === userId)?.id;
    },
    listMembers: async () => {
      recordCall(calls, "listMembers", {});
      return members.map((member) => makeMember(member));
    }
  };
};
