// This program is sent to Node on stdin inside the production image. It imports
// only emitted application modules; fixture generation runs in the host process.
export const notificationCapacityProbe = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createProxy, createConnection } from 'node:net';
import { createServer } from 'node:http';
import { createAppContext } from './dist/appContext.js';
import { closeDb } from './dist/db/client.js';
import { createDiscordClient } from './dist/discord/client.js';
import { createNotificationReceiver } from './dist/notifications/http.js';
import { validateNewNotification } from './dist/domain/resultNotificationPayload.js';
import { renderResultNotification } from './dist/features/result-notifications/render.js';
import { RESULT_NOTIFICATION_CONCURRENCY } from './dist/notifications/config.js';

assert.notEqual(process.getuid(), 0);
const client = createDiscordClient(); // Deliberately never connect to Discord.
const context = createAppContext();
let received = 0;
const receiver = createNotificationReceiver({
  port: { ...context.ports.resultNotifications, receive: (...args) => {
    received += 1; return context.ports.resultNotifications.receive(...args);
  } },
  clock: context.clock, token: process.env.PROBE_TOKEN,
  operationsToken: 'unused-capacity-operations-token-0000', canAccept: () => true,
  wake() {}, logger: { info() {}, warn() {}, error() {} }
});
await receiver.start('127.0.0.1', 0);
// The production receiver keeps its private bind. Only Docker's ephemeral host
// loopback ports reach this test-only proxy; its small overhead is measured too.
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
const retained = await context.ports.resultNotifications.claim({
  limit: RESULT_NOTIFICATION_CONCURRENCY, now: new Date(), claimDurationMs: 300_000
});
assert.equal(retained.length, RESULT_NOTIFICATION_CONCURRENCY);
const rendered = retained.map(entry => renderResultNotification(
  validateNewNotification(entry.payload), 'https://results.example.com'
));
const control = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.PROBE_TOKEN) {
    response.writeHead(401); response.end(); return;
  }
  receiver.stop(); await receiver.drain(); sample();
  const cgroupPeak = Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8'));
  response.end(JSON.stringify({ baselineRss, peakRss, maxRss: process.resourceUsage().maxRSS * 1024,
    cgroupPeak, received, retained: retained.length,
    renderedParts: rendered.reduce((total, value) => total + value.parts.length, 0) }));
  await closeDb(); await client.destroy(); clearInterval(timer);
  proxy.close(); control.close(() => process.exit(0));
});
await new Promise(resolve => control.listen(8001, '0.0.0.0', resolve));
console.log('CAPACITY_READY');
`;
