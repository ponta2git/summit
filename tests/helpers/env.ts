import { env } from "../../src/env.js";

// why: 複数のテストで `env.MEMBER_USER_IDS[0]` 取得 (+ 空配列ガード) が重複していた。
//   テスト用途では必ず 4 名 ID が注入されている前提なので、初回参照時に検査して固定する。
const firstMemberUserId = env.MEMBER_USER_IDS[0];
if (!firstMemberUserId) {
  throw new Error("member user id is required for test setup");
}

export const memberUserId: string = firstMemberUserId;
