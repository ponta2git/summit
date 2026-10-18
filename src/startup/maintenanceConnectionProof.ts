import { createHash } from "node:crypto";

export interface MaintenanceConnectionProof {
  readonly formatVersion: 1;
  readonly targetFingerprint: string;
  readonly ledgerFingerprint: string;
}

/** Shared v1 wire contract with momo-db and momo-result; never expose raw connection values. */
export const maintenanceConnectionProof = (
  target: URL, database: string, ledger: readonly { readonly hash: string; readonly created_at: string }[]
): MaintenanceConnectionProof => {
  if (!database || ledger.length === 0 || ledger.some(row => !/^[a-f0-9]{64}$/.test(row.hash) || !/^[0-9]+$/.test(row.created_at))) {
    throw new Error("Maintenance database proof is unavailable");
  }
  let host = target.hostname.toLowerCase();
  if (host.endsWith(".neon.tech")) { host = host.replace(/^([^.]+)-pooler\./, "$1."); }
  const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
  return {
    formatVersion: 1,
    targetFingerprint: sha256(JSON.stringify(["momo-database-target-v1", host, target.port || "5432", database])),
    ledgerFingerprint: sha256("momo-drizzle-ledger-v1\n" + ledger.map(row => `${row.hash}:${row.created_at}\n`).join(""))
  };
};
