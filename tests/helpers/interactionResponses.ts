import { vi } from "vitest";

// ack: Discordがackを受理する前の追答、初回応答の重複を拒否する最小protocol fake。
export const createInteractionResponses = (acknowledge: () => Promise<void> = async () => undefined) => {
  let state: "fresh" | "pending" | "acknowledged" | "failed" = "fresh";
  const ack = async (_payload?: unknown): Promise<void> => {
    if (state !== "fresh") { throw new Error("Interaction was already acknowledged or acknowledgement attempted"); }
    state = "pending";
    try { await acknowledge(); state = "acknowledged"; }
    catch (error) { state = "failed"; throw error; }
  };
  const follow = async (_payload?: unknown): Promise<void> => {
    if (state !== "acknowledged") { throw new Error("Interaction acknowledgement has not completed"); }
  };
  return {
    deferReply: vi.fn(ack), deferUpdate: vi.fn(ack), reply: vi.fn(ack),
    editReply: vi.fn(follow), followUp: vi.fn(follow)
  };
};
