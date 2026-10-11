// Injected into either production image; diagnostics are separate from timing baselines.
export const notificationPerformanceDatabase = `
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle as diagnosticDrizzle } from 'drizzle-orm/postgres-js';

const createPerformanceDatabase = ({ db, schema, record }) => {
  const enabled = process.env.PERF_DATABASE_DIAGNOSTICS === '1';
  if (!enabled) return { db, enabled, run: (_command, callback) => callback(),
    metrics: () => ({ enabled: false, byCommand: {} }), reset() {} };
  const scope = new AsyncLocalStorage();
  const commands = new Set(['receive', 'claim', 'plan', 'begin', 'complete', 'fail', 'renew',
    'yield', 'getNextDispatchAt', 'inspect', 'retry', 'prune', 'getSetting', 'setSetting']);
  let byCommand = Object.create(null);
  const counts = command => byCommand[command] ??= { drizzleStatements: 0,
    committedTransactions: 0, failedTransactions: 0, estimatedCommittedBeginCommitStatements: 0 };
  const recordDuration = (name, context, started, failed) =>
    record('database.' + name + '.' + context.command, performance.now() - started, failed);
  const measured = diagnosticDrizzle(db.$client, { schema, casing: 'snake_case', logger: {
    logQuery(query) {
      const context = scope.getStore();
      if (!context) return;
      counts(context.command).drizzleStatements++;
      // Only classify; never retain SQL, parameters, payloads, IDs or connection data.
      if (context.execution && /^\\s*select\\s+pg_advisory_xact_lock\\s*\\(/i.test(query)) {
        context.execution.gate = true;
      }
    }
  } });
  const transaction = measured.transaction.bind(measured);
  measured.transaction = (callback, options) => {
    const parent = scope.getStore();
    if (!parent) return transaction(callback, options);
    const context = { command: parent.command, acquiredAt: undefined };
    const started = performance.now();
    return scope.run(context, async () => {
      let failed = true;
      try {
        const result = await transaction(async tx => {
          // Includes pool acquisition, BEGIN and Drizzle's isolation setup, not pure pool wait.
          recordDuration('transactionEntry', context, started, false);
          const execute = tx.execute.bind(tx);
          tx.execute = (...args) => {
            const execution = { gate: false };
            const queryStarted = performance.now();
            return scope.run({ ...context, execution }, async () => {
              let queryFailed = true;
              try {
                const result = await execute(...args);
                queryFailed = false;
                if (execution.gate) context.acquiredAt = performance.now();
                return result;
              } finally {
                // This wall time includes driver, network and server wait/execution.
                if (execution.gate) recordDuration('gateCall', context, queryStarted, queryFailed);
              }
            });
          };
          return callback(tx);
        }, options);
        failed = false;
        counts(context.command).committedTransactions++;
        // postgres.js issues these outside Drizzle's logger; this is a successful-path estimate.
        counts(context.command).estimatedCommittedBeginCommitStatements += 2;
        return result;
      } finally {
        if (failed) counts(context.command).failedTransactions++;
        recordDuration('transactionWall', context, started, failed);
        // Includes commit/rollback settlement; absent when gate acquisition never succeeded.
        if (context.acquiredAt !== undefined) recordDuration('gateHold', context, context.acquiredAt, failed);
      }
    });
  };
  return { db: measured, enabled,
    run: (command, callback) => scope.run({ command: commands.has(command) ? command : 'other' }, async () => await callback()),
    metrics: () => ({ enabled, byCommand: Object.fromEntries(Object.entries(byCommand)
      .map(([command, value]) => [command, { ...value }])) }),
    reset: () => { byCommand = Object.create(null); }
  };
};
`;
