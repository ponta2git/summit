import type {
  MembersPort,
  SessionCommandsPort
} from "../../src/db/ports.js";
import { evaluateDeadline } from "../../src/domain/askDecision.js";
import { evaluatePostponeVote } from "../../src/domain/postponeDecision.js";
import { reminderAtFor } from "../../src/time/index.js";
import {
  buildDecidedAnnouncementIntent
} from "../../src/db/repositories/sessionOutboxIntents.js";
import { recordCall, type AnyCall } from "./ports.shared.js";
import type { FakeResponsesPort } from "./ports.responses.js";
import type { FakeSessionsPort } from "./ports.sessions.js";
import type { FakeHeldEventsPort } from "./ports.heldEvents.js";
import type { FakeOutboxPort } from "./ports.outbox.js";
import { createFakeCancelWeekCommand } from "./ports.sessionCommands.cancelWeek.js";
import {
  applyAskCancellation,
  applyPostponeDecision,
  hasMember,
  saveFreshResponse
} from "./ports.sessionCommands.helpers.js";

export interface FakeSessionCommandsPort extends SessionCommandsPort {
  readonly calls: ReadonlyArray<AnyCall>;
}

export const createFakeSessionCommandsPort = (
  sessions: FakeSessionsPort,
  responses: FakeResponsesPort,
  members: MembersPort,
  heldEvents: FakeHeldEventsPort,
  outbox: FakeOutboxPort
): FakeSessionCommandsPort => {
  const calls: AnyCall[] = [];
  return {
    calls,
    ...createFakeCancelWeekCommand(calls, sessions, heldEvents, outbox),
    submitAskResponse: async (input) => {
      recordCall(calls, "submitAskResponse", { input });
      const current = await sessions.findSessionById(input.sessionId);
      if (!current) {return { kind: "session_not_found" };}
      if (current.status !== "ASKING") {return { kind: "closed", session: current };}
      if (input.now.getTime() >= current.deadlineAt.getTime()) {
        return { kind: "deadline_passed", session: current };
      }
      if (!(await hasMember(members, input.memberId))) {
        return { kind: "member_not_found", session: current };
      }
      const saved = await saveFreshResponse(responses, {
        responseId: input.responseId,
        sessionId: input.sessionId,
        memberId: input.memberId,
        choice: input.choice,
        sourceInteractionId: input.sourceInteractionId,
        now: input.now
      });
      if (saved.kind === "stale") {
        return {
          kind: "stale_interaction",
          session: current,
          response: saved.response
        };
      }
      if (input.choice === "ABSENT") {
        return {
          kind: "transitioned",
          outcome: "cancelled",
          session: await applyAskCancellation(sessions, current, "absent", input.now),
          response: saved.response
        };
      }
      const bumped = sessions.bumpRevision(current.id, input.now);
      if (!bumped) {throw new Error("locked ask session disappeared");}
      return {
        kind: "accepted_pending",
        session: bumped,
        response: saved.response
      };
    },
    settleAskingCancellation: async (input) => {
      recordCall(calls, "settleAskingCancellation", { input });
      const current = await sessions.findSessionById(input.sessionId);
      if (!current) {return { kind: "session_not_found" };}
      if (current.status !== "ASKING" && current.status !== "CANCELLED") {
        return { kind: "closed", session: current };
      }
      return {
        kind: "transitioned",
        session: await applyAskCancellation(
          sessions,
          current,
          input.reason,
          input.now
        )
      };
    },
    settleAskingDeadline: async (input) => {
      recordCall(calls, "settleAskingDeadline", { input });
      const current = await sessions.findSessionById(input.sessionId);
      if (!current) {return { kind: "session_not_found" };}
      if (current.status !== "ASKING") {return { kind: "closed", session: current };}
      const responseRows = await responses.listResponses(current.id);
      const decision = evaluateDeadline(current, responseRows, {
        memberCountExpected: input.memberCountExpected,
        now: input.now
      });
      if (decision.kind === "pending") {
        return { kind: "not_due", session: current };
      }
      const transitioned =
        decision.kind === "decided"
          ? await sessions.decideAsking({
              id: current.id,
              now: input.now,
              decidedStartAt: decision.startAt,
              reminderAt: reminderAtFor(decision.startAt),
              outbox: [
                buildDecidedAnnouncementIntent({
                  ...current,
                  revision: current.revision + 1
                })
              ]
            })
          : await applyAskCancellation(
              sessions,
              current,
              decision.reason === "all_absent" ? "absent" : "deadline_unanswered",
              input.now
            );
      if (!transitioned) {throw new Error("locked ask session disappeared");}
      return {
        kind: "transitioned",
        outcome: decision.kind === "decided" ? "decided" : "cancelled",
        session: transitioned,
        responses: responseRows
      };
    },
    submitPostponeVote: async (input) => {
      recordCall(calls, "submitPostponeVote", { input });
      const current = await sessions.findSessionById(input.sessionId);
      if (!current) {return { kind: "session_not_found" };}
      if (current.status !== "POSTPONE_VOTING") {
        return { kind: "closed", session: current };
      }
      if (input.now.getTime() >= current.deadlineAt.getTime()) {
        return { kind: "deadline_passed", session: current };
      }
      if (!(await hasMember(members, input.memberId))) {
        return { kind: "member_not_found", session: current };
      }
      const saved = await saveFreshResponse(responses, {
        responseId: input.responseId,
        sessionId: input.sessionId,
        memberId: input.memberId,
        choice: input.choice,
        sourceInteractionId: input.sourceInteractionId,
        now: input.now
      });
      if (saved.kind === "stale") {
        return {
          kind: "stale_interaction",
          session: current,
          response: saved.response
        };
      }
      const responseRows = await responses.listResponses(current.id);
      const decision = evaluatePostponeVote(current, responseRows, {
        memberCountExpected: input.memberCountExpected,
        now: input.now
      });
      if (decision.kind === "pending") {
        const bumped = sessions.bumpRevision(current.id, input.now);
        if (!bumped) {throw new Error("locked postpone session disappeared");}
        return {
          kind: "accepted_pending",
          session: bumped,
          response: saved.response
        };
      }
      return {
        kind: "transitioned",
        response: saved.response,
        ...(await applyPostponeDecision(sessions, current, decision, input))
      };
    },
    settlePostponeVoting: async (input) => {
      recordCall(calls, "settlePostponeVoting", { input });
      const current = await sessions.findSessionById(input.sessionId);
      if (!current) {return { kind: "session_not_found" };}
      if (current.status !== "POSTPONE_VOTING") {
        return { kind: "closed", session: current };
      }
      const responseRows = await responses.listResponses(current.id);
      const decision = evaluatePostponeVote(current, responseRows, {
        memberCountExpected: input.memberCountExpected,
        now: input.now
      });
      if (decision.kind === "pending") {
        return { kind: "not_due", session: current };
      }
      return {
        kind: "transitioned",
        ...(await applyPostponeDecision(sessions, current, decision, input))
      };
    }
  };
};
