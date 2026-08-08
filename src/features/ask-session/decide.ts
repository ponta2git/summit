// Compatibility surface: pure aggregate decision logic lives in the domain layer.
export {
  evaluateDeadline,
  type DecisionResult,
  type EvaluateDeadlineOptions,
  type SlotKey
} from "../../domain/askDecision.ts";
