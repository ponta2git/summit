import assert from "node:assert/strict";
import { request } from "node:http";
import type postgres from "postgres";
import { RESULT_NOTIFICATION_MAX_BODY_BYTES, RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../src/notifications/config.ts";
import { ocrNotification } from "../../tests/features/result-notifications/fixtures.ts";
import { capacityMetrics, CapacityError, type CapacityMetrics } from "./notificationCapacity.contract.ts";
import { canonicalCapacityBytes, capacityAnalysis, capacityNamePoints } from "./notificationCapacity.fixtures.ts";

export interface CapacitySession {
  readonly receiverOrigin: string;
  readonly controlOrigin: string;
  readonly token: string;
  readonly signal: AbortSignal;
}

const capacityControl = async (session: CapacitySession, path: string): Promise<CapacityMetrics> => {
  const response = await fetch(session.controlOrigin + path, {
    headers: { authorization: `Bearer ${session.token}` }, signal: session.signal
  });
  if (response.status !== 200) { throw new CapacityError("setup_or_measurement"); }
  return capacityMetrics.parse(await response.json());
};

const postRaw = (session: CapacitySession, raw: string, options: { wireBytes?: number; chunked?: boolean } = {}): Promise<number> => {
  const bytes = Buffer.byteLength(raw);
  const body = Buffer.from(raw + " ".repeat(Math.max(0, (options.wireBytes ?? bytes) - bytes)));
  return new Promise((resolve, reject) => {
    let responseStatus: number | undefined;
    const failed = (error: Error & { code?: string }): void => {
      // A peer may close before draining a rejected chunked request. An observed
      // error status is still a real rejection; successful statuses must finish.
      if (responseStatus !== undefined && responseStatus >= 400) { resolve(responseStatus); return; }
      const code = ["ECONNRESET", "EPIPE", "ABORT_ERR"].includes(error.code ?? "") ? error.code : "unknown";
      reject(new CapacityError("setup_or_measurement", `http_${code}`));
    };
    const call = request(session.receiverOrigin + "/internal/discord-notifications", {
      method: "POST", signal: session.signal, headers: { authorization: `Bearer ${session.token}`,
        "content-type": "application/json", ...(options.chunked ? {} : { "content-length": body.length }) }
    }, response => {
      responseStatus = response.statusCode;
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", failed);
    });
    call.once("error", failed);
    if (options.chunked) { call.write(body.subarray(0, Math.floor(body.length / 2))); call.end(body.subarray(Math.floor(body.length / 2))); }
    else { call.end(body); }
  });
};
const post = (session: CapacitySession, value: unknown, options: { wireBytes?: number; chunked?: boolean } = {}): Promise<number> =>
  postRaw(session, JSON.stringify(value), options);

const accepted = async (result: Promise<number>): Promise<void> => {
  if (await result !== 202) { throw new CapacityError("receipt_rejected"); }
};

const exerciseExpandedConflicts = async (session: CapacitySession, client: postgres.Sql, sourceJobId: string) => {
  const base = JSON.stringify(capacityAnalysis(sourceJobId, "normal"));
  // A wire-small, previously known identity can use the legacy canonical budget
  // before its different content is rejected. PostgreSQL expands each exponent.
  const raw = `${base.slice(0, -1)},"capacityNumericMetadata":[${Array.from({ length: 80 }, () => "1e100000").join(",")}]}`;
  const [row] = await client<{ bytes: number }[]>`SELECT octet_length(${raw}::jsonb::text) AS bytes`;
  assert.ok(row && row.bytes > 7.5 * 1024 * 1024 && row.bytes <= 8 * 1024 * 1024);
  await capacityControl(session, "/hold-receipts");
  // Small wire bodies reserve the receiver minimum, so all four receipt slots
  // can be occupied despite each canonical response approaching 8 MiB.
  const responses = Promise.all(Array.from({ length: 4 }, () => postRaw(session, raw)));
  void responses.catch(() => undefined);
  await capacityControl(session, "/wait/receipts/4");
  await capacityControl(session, "/release-receipts");
  assert.deepEqual(await responses, [409, 409, 409, 409]);
  return row.bytes;
};

const rejectedOversizedBody = async (session: CapacitySession, chunked: boolean): Promise<void> => {
  try {
    assert.equal(await post(session, capacityAnalysis(`capacity-invalid-${chunked ? "chunked" : "wire"}`, "normal"), {
      wireBytes: RESULT_NOTIFICATION_MAX_BODY_BYTES + 1, chunked
    }), 413);
  } catch (error) {
    // Closing with unread body bytes may reset the socket before the 413 reaches
    // the client. Later DB assertions and a live control request rule out intake
    // or a dead server being mistaken for successful overload protection.
    if (!(error instanceof CapacityError && ["http_ECONNRESET", "http_EPIPE"].includes(error.detail ?? ""))) { throw error; }
  }
};

export const exerciseStandardCapacity = async (session: CapacitySession, client: postgres.Sql) => {
  const phases: { phase: string; cgroupPeakMiB: number }[] = [];
  const measure = async (phase: string): Promise<void> => {
    const metrics = await capacityControl(session, "/stats");
    const measured = { phase, cgroupPeakMiB: metrics.cgroupPeak / 1024 / 1024 };
    phases.push(measured);
    console.log(JSON.stringify({ event: "notification_capacity.phase", scenario: "standard", ...measured }));
  };
  const points = await capacityNamePoints(client, RESULT_NOTIFICATION_MAX_JSONB_BYTES);
  const maximum = (suffix: string) => capacityAnalysis(`capacity-maximum-${suffix}`, "unicode", points);
  const nearBytes = await canonicalCapacityBytes(client, maximum("000"));
  const wire = { wireBytes: RESULT_NOTIFICATION_MAX_BODY_BYTES };
  const ids: string[] = [];
  const enqueue = async (value: ReturnType<typeof capacityAnalysis>, options: { wireBytes?: number; chunked?: boolean } = wire): Promise<void> => {
    ids.push(value.notificationId); await accepted(post(session, value, options));
  };
  await enqueue(capacityAnalysis("capacity-normal", "normal"));
  await capacityControl(session, "/wait/delivered/1");
  await measure("normal_delivered");

  await capacityControl(session, "/hold-delivery");
  await Promise.all([enqueue(maximum("001")), enqueue(maximum("002"))]);
  await capacityControl(session, "/wait/sends/2");
  await measure("two_deliveries_held");
  await capacityControl(session, "/hold-receipts");
  const outstanding = Promise.all([enqueue(maximum("003")), enqueue(maximum("004"))]);
  void outstanding.catch(() => undefined);
  const held = await capacityControl(session, "/wait/receipts/2");
  assert.equal(held.pendingReceipts, 2);
  await measure("two_deliveries_and_two_receipts_held");
  // With 2 x 512 KiB reservations held, unknown-length requests must fail closed.
  assert.equal(await post(session, ocrNotification(), { chunked: true }), 503);
  await capacityControl(session, "/release-receipts");
  await outstanding;
  const conflictJsonbBytes = await exerciseExpandedConflicts(session, client, "capacity-normal");
  await measure("two_deliveries_with_expanded_identity_conflicts");
  await capacityControl(session, "/release-delivery");
  await capacityControl(session, "/wait/delivered/5");
  await measure("overlap_drained");

  for (let burst = 0; burst < 5; burst++) {
    await Promise.all([enqueue(maximum(`b${burst}0`)),
      enqueue(capacityAnalysis(`capacity-markdown-${burst}`, "markdown"))]);
    await capacityControl(session, `/wait/delivered/${7 + burst * 2}`);
  }
  await measure("five_bursts_drained");
  await enqueue(maximum("end"), { ...wire, chunked: true });
  await capacityControl(session, "/wait/delivered/16");
  const ocr = { ...ocrNotification(), settingsGeneration: "0" };
  await accepted(post(session, ocr)); ids.push(ocr.notificationId);
  await capacityControl(session, "/wait/delivered/17");
  await measure("chunked_and_ocr_delivered");

  const excessive = capacityAnalysis("capacity-invalid-canonical", "unicode");
  assert.ok(await canonicalCapacityBytes(client, excessive) > RESULT_NOTIFICATION_MAX_JSONB_BYTES);
  assert.equal(await post(session, excessive), 413);
  await rejectedOversizedBody(session, false);
  await rejectedOversizedBody(session, true);
  const extraMatch = capacityAnalysis("capacity-invalid-count", "markdown");
  const first = extraMatch.data.matches[0];
  assert.ok(first);
  const invalidStatus = await post(session, { ...extraMatch, data: { ...extraMatch.data,
    matches: [...extraMatch.data.matches, { ...first, matchId: "extra-match" }] } });
  assert.equal(invalidStatus, 413);
  const [persisted] = await client<{ count: number; delivered: number; parts: number }[]>`
    SELECT count(*)::int AS count, count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
      sum(part_count)::int AS parts FROM discord_notifications WHERE family = 'result'`;
  assert.equal(persisted?.count, ids.length);
  assert.equal(persisted?.delivered, ids.length);
  const metrics = await capacityControl(session, "/finish");
  assert.equal(metrics.deliveredNotifications, ids.length);
  assert.equal(metrics.sentParts, persisted?.parts);
  assert.equal(metrics.maxPendingSends, 2);
  assert.equal(metrics.maxPendingReceipts, 4);
  assert.ok(metrics.maxClaimBatchBytes <= 512 * 1024);
  assert.ok(metrics.maxClaimBatchCount <= 2);
  return { metrics, workload: { notifications: ids.length, completedParts: metrics.sentParts,
    burstRounds: 5, nearJsonbBytes: nearBytes,
    wireBytes: wire.wireBytes, rejectedCases: 9, conflictJsonbBytes, overlappingConflicts: 4,
    maxMatches: 50, maxSeasons: 16, phases } };
};

export const exerciseLegacyCapacity = async (session: CapacitySession, client: postgres.Sql) => {
  await capacityControl(session, "/hold-delivery");
  await capacityControl(session, "/wake");
  await capacityControl(session, "/wait/sends/1");
  const conflictJsonbBytes = await exerciseExpandedConflicts(session, client, "capacity-legacy");
  // Planning the complete legacy message list is real DB work. Finish only the
  // started first send; stop prevents thousands of irrelevant I/O round trips.
  const metrics = await capacityControl(session, "/finish");
  assert.equal(metrics.maxPendingSends, 1);
  assert.equal(metrics.maxClaimBatchCount, 1);
  assert.equal(metrics.sentParts, 1);
  const [row] = await client<{ count: number; delivered: number; pending: number }[]>`
    SELECT count(*)::int AS count, count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending FROM discord_notification_parts
    WHERE notification_id = 'result:analysis_completed:capacity-legacy'`;
  assert.ok(row && row.count > 8_000 && row.count <= 10_000);
  assert.equal(row.delivered, 1);
  assert.equal(row.pending, row.count - 1);
  return { metrics, workload: { plannedParts: row.count, completedParts: row.delivered,
    conflictJsonbBytes, overlappingConflicts: 4 } };
};
