import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const image = process.argv[2];
if (!image || process.argv.length !== 3 || image.startsWith("-")) {
  throw new Error("Usage: node scripts/verify/runtimeImage.ts <local-image>");
}

// No app bootstrap, credentials, network or persistent writes are needed for this gate.
const probe = `
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
assert.notEqual(process.getuid(), 0, 'Runtime must not run as root');
assert.equal(process.env.NODE_ENV, 'production');
const checkOwnership = path => {
  const entry = lstatSync(path);
  assert.equal(entry.uid, 0, 'Application tree must remain owned by root: ' + path);
  if (!entry.isSymbolicLink()) {
    assert.equal(entry.mode & 0o022, 0, 'Application tree must not be writable by group or others: ' + path);
  }
  return entry;
};
const checkTree = path => {
  const entry = checkOwnership(path);
  if (entry.isDirectory()) { for (const name of readdirSync(path)) { checkTree(join(path, name)); } }
};
// --read-only is probe isolation; mode checks also catch image regressions hidden by that mount.
checkOwnership('/app');
checkTree('/app/summit');
checkTree('/app/momo-db');
await assert.rejects(access('dist/index.js', constants.W_OK));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const entries = { 'discord-api-types': 'discord-api-types/v10', effect: 'effect/Effect' };
await Promise.all(Object.keys(manifest.dependencies).map(name => import(entries[name] ?? name)));
await import('@momo/db/notifications');
await import('./dist/commands/definitions.js');
for (const name of ['vitest', 'typescript', 'vite', 'oxlint', 'knip']) {
  await assert.rejects(access('node_modules/' + name));
}
console.log('Runtime image: non-root, read-only code, production dependencies and shared schema imports verified');
`;

const containerName = `summit-runtime-check-${randomUUID()}`;
const result = spawnSync("docker", ["run", "--rm", "--pull=never", "--name", containerName, "--network", "none", "--read-only",
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", "-i", image,
  "--input-type=module", "-"], { input: probe, stdio: ["pipe", "inherit", "inherit"], timeout: 30_000 });
if (result.error || result.signal || result.status !== 0) {
  // A killed Docker CLI can leave its container running; clean up only this invocation's name.
  spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore", timeout: 10_000 });
  process.stderr.write("Runtime image verification failed.\n");
  process.exitCode = 1;
}
