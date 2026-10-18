import { describe, expect, it } from "vitest";
import { maintenanceConnectionProof } from "../../src/startup/maintenanceConnectionProof.ts";

const ledger = [{ hash: "a".repeat(64), created_at: "1730000000000" }, { hash: "b".repeat(64), created_at: "1730000000001" }];
const target = new URL("postgresql://role:secret@ep-fixture.example.neon.tech/configured");

describe("maintenance connection proof", () => {
  it("matches the shared wire vector using the actual database and ordered ledger", () => {
    const proof = maintenanceConnectionProof(target, "actual", ledger);
    expect(proof).toStrictEqual({ formatVersion: 1,
      targetFingerprint: "6771b0dca574fd57070c4e09362db28a2603f50c6a31c7ace1690390a4fa7169",
      ledgerFingerprint: "6c999946c7604635b2672944e5bd546152a17281205cfb4429ed3df8d20cd5ab" });
    expect(maintenanceConnectionProof(new URL("postgresql://another@ep-fixture-pooler.example.neon.tech/ignored"), "actual", ledger)).toStrictEqual(proof);
    expect(maintenanceConnectionProof(target, "recovered", ledger).targetFingerprint).not.toBe(proof.targetFingerprint);
    expect(maintenanceConnectionProof(target, "actual", ledger.toReversed()).ledgerFingerprint).not.toBe(proof.ledgerFingerprint);
    expect(() => maintenanceConnectionProof(target, "actual", [])).toThrow("proof is unavailable");
  });
});
