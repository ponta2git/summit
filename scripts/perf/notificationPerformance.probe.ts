import { notificationPerformanceTelemetry } from "./notificationPerformance.telemetry.ts";

// The host supplies only synthetic fixtures and disposable local DB credentials.
// Only the Discord transport is replaced; admission, SQL and dispatch stay real.
export const notificationPerformanceProbe = `
import assert from 'node:assert/strict';
import { LimitedCollection } from 'discord.js';
import { createServer as createProxy, createConnection } from 'node:net';
import { createServer } from 'node:http';
import { createAppContext } from './dist/appContext.js';
import { closeDb } from './dist/db/client.js';
import { createDiscordClient } from './dist/discord/client.js';
import { createNotificationReceiver } from './dist/notifications/http.js';
import { createResultNotificationDispatcher } from './dist/scheduler/resultNotifications.js';
import { notificationNonce } from './dist/scheduler/deliveryNonce.js';
${notificationPerformanceTelemetry}

assert.notEqual(process.getuid(), 0);
assert.equal(typeof globalThis.gc, 'function');
const client = createDiscordClient();
const context = createAppContext();
let telemetry;
let holdDelivery = false, holdReceipts = false, finished = false;
let pendingSends = 0, pendingReceipts = 0, inflightOperations = 0;
let maxPendingSends = 0, maxPendingReceipts = 0, maxInflightOperations = 0;
let received = 0, sentParts = 0, sendAttempts = 0, deliveredNotifications = 0;
let maxClaimBatchBytes = 0, maxClaimBatchCount = 0, maxActivePayloadBytes = 0;
let protocolFailures = 0, applicationWarnings = 0, applicationErrors = 0;
let receiptDispositions = Object.create(null);
let ordinal = 0;
const traces = new Map();
const begun = new Map();
const observers = new Set();
let completed = [];
const freshLatencies = () => ({ receiptToFirstSend: [], receiptToComplete: [],
  claimToFirstSend: [], claimToComplete: [], firstSendToComplete: [] });
let latencies = freshLatencies();
const changed = () => { for (const resolve of observers) resolve(); observers.clear(); };
const waitFor = async predicate => { while (!predicate()) await new Promise(resolve => observers.add(resolve)); };
const logger = { info() {}, warn() { applicationWarnings++; }, error() { applicationErrors++; changed(); } };
const traceFor = id => {
  let trace = traces.get(id);
  if (!trace) {
    assert.ok(traces.size < 100000);
    trace = { ordinal: ++ordinal }; traces.set(id, trace);
  }
  return trace;
};
const original = context.ports.resultNotifications;
const call = async (name, args, part) => {
  const started = performance.now(); let failed = true;
  inflightOperations++; maxInflightOperations = Math.max(maxInflightOperations, inflightOperations);
  try { const result = await original[name](...args); failed = false; return result; }
  finally { telemetry.record(name, performance.now() - started, failed, part); inflightOperations--; changed(); }
};
const port = Object.fromEntries(Object.keys(original).map(name => [name, (...args) => call(name, args)]));
port.receive = async (...args) => {
  const started = performance.now(); let failed = true;
  received++; pendingReceipts++; maxPendingReceipts = Math.max(maxPendingReceipts, pendingReceipts); changed();
  try {
    await waitFor(() => !holdReceipts);
    const result = await call('receive', args);
    failed = false; receiptDispositions[result.disposition] = (receiptDispositions[result.disposition] ?? 0) + 1;
    if (result.disposition === 'accepted') traceFor(result.notificationId).receiptAt = started;
    return result;
  } finally { telemetry.record('receiveTotal', performance.now() - started, failed); pendingReceipts--; changed(); }
};
port.claim = async options => {
  const rows = await call('claim', [options]);
  maxClaimBatchCount = Math.max(maxClaimBatchCount, rows.length);
  maxClaimBatchBytes = Math.max(maxClaimBatchBytes, rows.reduce((total, row) => total + row.payloadBytes, 0));
  for (const row of rows) { const trace = traceFor(row.id); trace.claimAt ??= performance.now(); trace.payloadBytes = row.payloadBytes; }
  maxActivePayloadBytes = Math.max(maxActivePayloadBytes, [...traces.values()].reduce((sum, trace) => sum + (trace.payloadBytes ?? 0), 0));
  return rows;
};
port.plan = async (id, token, options) => {
  const result = await call('plan', [id, token, options]);
  if (result) traceFor(id).parts = options.count; else traces.delete(id);
  return result;
};
port.begin = async (id, partNo, ...args) => {
  const trace = traceFor(id);
  const result = await call('begin', [id, partNo, ...args], { notificationOrdinal: trace.ordinal, partNo });
  if (result) begun.set(notificationNonce(id, partNo), { trace, partNo }); else traces.delete(id);
  return result;
};
port.complete = async (id, partNo, ...args) => {
  const trace = traceFor(id);
  const result = await call('complete', [id, partNo, ...args], { notificationOrdinal: trace.ordinal, partNo });
  if (result && partNo + 1 === trace.parts) {
    const now = performance.now();
    if (trace.receiptAt !== undefined) telemetry.append(latencies.receiptToComplete, now - trace.receiptAt);
    if (trace.claimAt !== undefined) telemetry.append(latencies.claimToComplete, now - trace.claimAt);
    if (trace.firstSendAt !== undefined) telemetry.append(latencies.firstSendToComplete, now - trace.firstSendAt);
    telemetry.append(completed, { notificationOrdinal: trace.ordinal, parts: trace.parts, payloadBytes: trace.payloadBytes,
      origin: trace.receiptAt === undefined ? 'seeded_claim' : 'receipt',
      receiptToFirstSendMs: trace.receiptAt === undefined ? null : trace.firstSendAt - trace.receiptAt,
      receiptToCompleteMs: trace.receiptAt === undefined ? null : now - trace.receiptAt,
      claimToFirstSendMs: trace.claimAt === undefined ? null : trace.firstSendAt - trace.claimAt,
      claimToCompleteMs: trace.claimAt === undefined ? null : now - trace.claimAt,
      firstSendToCompleteMs: trace.firstSendAt === undefined ? null : now - trace.firstSendAt });
    traces.delete(id); deliveredNotifications++; changed();
  }
  return result;
};
port.fail = async (id, ...args) => { try { return await call('fail', [id, ...args]); } finally { traces.delete(id); } };
const messages = { cache: new LimitedCollection({ maxSize: 200 }) };
client.channels.fetch = async () => ({ type: 0, isSendable: () => true, messages, send: async body => {
  let part;
  try {
    assert.equal(typeof body.content, 'string'); assert.ok(body.content.length > 0 && body.content.length <= 2000);
    assert.deepEqual(body.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    assert.equal(body.enforceNonce, true); assert.equal(typeof body.nonce, 'string');
    part = begun.get(body.nonce); assert.ok(part);
  } catch (error) { protocolFailures++; changed(); throw error; }
  const now = performance.now();
  if (part.trace.firstSendAt === undefined) {
    part.trace.firstSendAt = now;
    if (part.trace.receiptAt !== undefined) telemetry.append(latencies.receiptToFirstSend, now - part.trace.receiptAt);
    if (part.trace.claimAt !== undefined) telemetry.append(latencies.claimToFirstSend, now - part.trace.claimAt);
  }
  pendingSends++; sendAttempts++; maxPendingSends = Math.max(maxPendingSends, pendingSends); changed();
  try {
    await waitFor(() => !holdDelivery);
    const message = { id: 'performance-message-' + (++sentParts) };
    messages.cache.set(message.id, message);
    return message;
  }
  finally { pendingSends--; begun.delete(body.nonce); changed(); }
} });
const dispatcher = createResultNotificationDispatcher({ client, port, clock: context.clock,
  context: { channelId: 'performance-channel', webOrigin: 'https://results.example.com' }, logger });
const receiver = createNotificationReceiver({ port, clock: context.clock, token: process.env.PROBE_TOKEN,
  operationsToken: process.env.RESULT_NOTIFICATION_OPERATIONS_TOKEN, canAccept: () => true,
  wake: reason => dispatcher.wake(reason), logger });
await receiver.start('127.0.0.1', 0);
const proxy = createProxy(socket => {
  const upstream = createConnection({ host: '127.0.0.1', port: receiver.server.address().port });
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy()); socket.pipe(upstream).pipe(socket);
});
await new Promise(resolve => proxy.listen(8000, '0.0.0.0', resolve));
telemetry = await createPerformanceTelemetry();
const counters = () => ({ received, sentParts, sendCount: sentParts, sendAttempts, deliveredNotifications,
  pendingSends, pendingReceipts, inflightOperations, activeNotifications: traces.size,
  maxPendingSends, maxPendingReceipts, maxInflightOperations, maxClaimBatchBytes, maxClaimBatchCount, maxActivePayloadBytes,
  protocolFailures, applicationWarnings, applicationErrors, receiptDispositions });
const idle = () => pendingSends === 0 && pendingReceipts === 0 && inflightOperations === 0 && traces.size === 0;
const awaitIdle = async () => {
  await waitFor(() => idle() || protocolFailures > 0 || applicationErrors > 0);
  assert.ok(idle()); assert.equal(protocolFailures, 0); assert.equal(applicationErrors, 0);
};
const reset = async () => {
  await awaitIdle();
  received = 0; sentParts = 0; sendAttempts = 0; deliveredNotifications = 0;
  maxPendingSends = 0; maxPendingReceipts = 0; maxInflightOperations = 0;
  maxClaimBatchBytes = 0; maxClaimBatchCount = 0; maxActivePayloadBytes = 0;
  protocolFailures = 0; applicationWarnings = 0; applicationErrors = 0;
  receiptDispositions = Object.create(null); ordinal = 0; completed = []; latencies = freshLatencies(); begun.clear();
  await telemetry.reset();
};
// server.close() reaps responses whose end() was called even while their socket
// still has queued bytes. Keep the control server open until the write flushes.
const flushResponse = (response, write) => new Promise(resolve => {
  let settled = false;
  const settle = succeeded => {
    if (settled) return;
    settled = true;
    response.removeListener('finish', onFinish);
    response.removeListener('error', onError);
    response.removeListener('close', onClose);
    resolve(succeeded);
  };
  const onFinish = () => settle(true);
  const onError = () => settle(false);
  const onClose = () => settle(response.writableFinished);
  response.once('finish', onFinish); response.once('error', onError); response.once('close', onClose);
  if (response.destroyed) { settle(false); return; }
  try { write(); } catch { settle(false); response.destroy(); }
});
const control = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.PROBE_TOKEN) {
    response.writeHead(401); response.end(); return;
  }
  response.setHeader('content-type', 'application/json'); response.setHeader('connection', 'close');
  try {
    if (finished) throw new Error('Probe is finishing');
    const path = request.url;
    if (path === '/hold-delivery') holdDelivery = true;
    else if (path === '/release-delivery') { holdDelivery = false; changed(); }
    else if (path === '/hold-receipts') holdReceipts = true;
    else if (path === '/release-receipts') { holdReceipts = false; changed(); }
    else if (path === '/wake') dispatcher.wake('performance_probe');
    else if (path === '/reset') await reset();
    else if (path === '/gc') { await awaitIdle(); await telemetry.diagnosticGc(); }
    else if (path?.startsWith('/wait/')) {
      const [, , subject, value] = path.split('/'); const target = Number(value);
      assert.ok(Number.isSafeInteger(target) && target >= 1 && target <= 100000);
      assert.ok(['sends', 'receipts', 'delivered'].includes(subject));
      await waitFor(() => protocolFailures > 0 || applicationErrors > 0 || (subject === 'sends' ? pendingSends
        : subject === 'receipts' ? pendingReceipts : deliveredNotifications) >= target);
      assert.equal(protocolFailures, 0); assert.equal(applicationErrors, 0);
    } else if (path !== '/stats' && path !== '/finish') throw new Error('Invalid probe command');
    if (path === '/finish') {
      finished = true; dispatcher.stop(); receiver.stop(); holdDelivery = false; holdReceipts = false; changed();
      await Promise.all([dispatcher.drain(), receiver.drain()]);
      const result = await telemetry.finish();
      const metrics = { ...result.metrics, ...counters(), notificationLatencyMs: latencies, completedNotifications: completed };
      const cpuJson = JSON.stringify(result.cpuProfile ?? null); const heapJson = JSON.stringify(result.heapProfile ?? null);
      const metricsJson = JSON.stringify(metrics);
      result.finalization.postSerialization = await telemetry.checkpoint();
      await closeDb(); await client.destroy(); proxy.close();
      const flushed = await flushResponse(response, () => {
        response.write(metricsJson.slice(0, -1) + ',"finalization":' + JSON.stringify(result.finalization) + ',"cpuProfile":');
        response.write(cpuJson); response.write(',"heapProfile":'); response.end(heapJson + '}');
      });
      if (!flushed) response.destroy();
      control.close(() => process.exit(flushed ? 0 : 1));
    } else response.end(JSON.stringify({ ...await telemetry.metrics(), ...counters() }));
  } catch {
    protocolFailures++; changed(); response.writeHead(500); response.end('{"error":"probe_contract"}');
  }
});
control.maxConnections = 8;
control.requestTimeout = 30000;
await new Promise(resolve => control.listen(8001, '0.0.0.0', resolve));
console.log('PERFORMANCE_READY');
`;
