// Executed inside the production image. Fixtures and persistence assertions stay
// in the host process, outside the measured cgroup.
export const notificationCapacityProbe = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createProxy, createConnection } from 'node:net';
import { createServer } from 'node:http';
import { createAppContext } from './dist/appContext.js';
import { closeDb } from './dist/db/client.js';
import { createDiscordClient } from './dist/discord/client.js';
import { createNotificationReceiver } from './dist/notifications/http.js';
import { createResultNotificationDispatcher } from './dist/scheduler/resultNotifications.js';

assert.notEqual(process.getuid(), 0);
const client = createDiscordClient(); // Never log in or call the Discord network.
const context = createAppContext();
const logger = { info() {}, warn() {}, error() {} };
const observers = new Set();
const changed = () => { for (const resolve of observers) resolve(); observers.clear(); };
const waitFor = async predicate => {
  while (!predicate()) await new Promise(resolve => observers.add(resolve));
};
let holdDelivery = false;
let holdReceipts = false;
let pendingSends = 0;
let pendingReceipts = 0;
let maxPendingSends = 0;
let maxPendingReceipts = 0;
let received = 0;
let sentParts = 0;
let deliveredNotifications = 0;
let maxClaimBatchBytes = 0;
let maxClaimBatchCount = 0;
let protocolFailures = 0;
const plans = new Map();
const original = context.ports.resultNotifications;
const port = {
  ...original,
  receive: async (...args) => {
    received++; pendingReceipts++;
    maxPendingReceipts = Math.max(maxPendingReceipts, pendingReceipts); changed();
    // A stalled receipt keeps the real receiver's reservation alive, like a DB
    // wait. The actual receipt transaction still runs after this barrier.
    try { await waitFor(() => !holdReceipts); return await original.receive(...args); }
    finally { pendingReceipts--; changed(); }
  },
  claim: async options => {
    const rows = await original.claim(options);
    maxClaimBatchCount = Math.max(maxClaimBatchCount, rows.length);
    maxClaimBatchBytes = Math.max(maxClaimBatchBytes, rows.reduce((total, row) => total + row.payloadBytes, 0));
    return rows;
  },
  plan: async (id, token, options) => {
    const result = await original.plan(id, token, options);
    if (result) plans.set(id, options.count);
    return result;
  },
  complete: async (id, partNo, ...args) => {
    const result = await original.complete(id, partNo, ...args);
    if (result && partNo + 1 === plans.get(id)) { deliveredNotifications++; changed(); }
    return result;
  }
};
client.channels.fetch = async () => ({ type: 0, isSendable: () => true, send: async body => {
  try {
    assert.equal(typeof body.content, 'string');
    assert.ok(body.content.length > 0 && body.content.length <= 2000);
    assert.deepEqual(body.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    assert.equal(body.enforceNonce, true);
    assert.equal(typeof body.nonce, 'string');
  } catch (error) { protocolFailures++; changed(); throw error; }
  pendingSends++; maxPendingSends = Math.max(maxPendingSends, pendingSends); changed();
  try { await waitFor(() => !holdDelivery); return { id: 'capacity-message-' + (++sentParts) }; }
  finally { pendingSends--; changed(); }
} });
const dispatcher = createResultNotificationDispatcher({ client, port, clock: context.clock,
  context: { channelId: 'capacity-channel', webOrigin: 'https://results.example.com' }, logger });
const receiver = createNotificationReceiver({ port, clock: context.clock, token: process.env.PROBE_TOKEN,
  operationsToken: process.env.RESULT_NOTIFICATION_OPERATIONS_TOKEN, canAccept: () => true,
  wake: reason => dispatcher.wake(reason), logger });
await receiver.start('127.0.0.1', 0);
// Preserve the production private bind; only Docker's host-loopback port reaches
// this test proxy. Its buffers count toward the measured container memory.
const proxy = createProxy(socket => {
  const upstream = createConnection({ host: '127.0.0.1', port: receiver.server.address().port });
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
await new Promise(resolve => proxy.listen(8000, '0.0.0.0', resolve));
globalThis.gc();
const baselineRss = process.memoryUsage().rss;
let peakRss = baselineRss;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const timer = setInterval(sample, 5);
const metrics = async () => {
  sample();
  return { baselineRss, peakRss, maxRss: process.resourceUsage().maxRSS * 1024,
    cgroupPeak: Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8')),
    received, sentParts, deliveredNotifications, pendingSends, pendingReceipts,
    maxPendingSends, maxPendingReceipts, maxClaimBatchBytes, maxClaimBatchCount, protocolFailures };
};
const control = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.PROBE_TOKEN) {
    response.writeHead(401); response.end(); return;
  }
  try {
    const path = request.url;
    if (path === '/hold-delivery') holdDelivery = true;
    else if (path === '/release-delivery') { holdDelivery = false; changed(); }
    else if (path === '/hold-receipts') holdReceipts = true;
    else if (path === '/release-receipts') { holdReceipts = false; changed(); }
    else if (path === '/wake') dispatcher.wake('capacity_probe');
    else if (path?.startsWith('/wait/')) {
      const [, , subject, value] = path.split('/');
      const target = Number(value);
      assert.ok(Number.isSafeInteger(target) && target >= 1 && target <= 100);
      assert.ok(['sends', 'receipts', 'delivered'].includes(subject));
      await waitFor(() => protocolFailures > 0 || (subject === 'sends' ? pendingSends
        : subject === 'receipts' ? pendingReceipts : deliveredNotifications) >= target);
      assert.equal(protocolFailures, 0);
    } else if (path !== '/stats' && path !== '/finish') throw new Error('Invalid probe command');
    if (path === '/finish') {
      dispatcher.stop(); receiver.stop(); holdDelivery = false; holdReceipts = false; changed();
      await Promise.all([dispatcher.drain(), receiver.drain()]);
      const result = await metrics();
      await closeDb(); await client.destroy(); clearInterval(timer); proxy.close();
      response.end(JSON.stringify(result)); control.close(() => process.exit(0));
    } else response.end(JSON.stringify(await metrics()));
  } catch { protocolFailures++; changed(); response.writeHead(500); response.end('{"error":"probe_contract"}'); }
});
await new Promise(resolve => control.listen(8001, '0.0.0.0', resolve));
console.log('CAPACITY_READY');
`;
