/**
 * Builds the directory published to npm, dist/npm/:
 *
 * - cli.js: one ES module for Node, with the dependencies left as imports so npm installs them.
 *   The source shebang runs Bun, so it is swapped for a Node one.
 * - package.json: the fields a user's install needs, taken from the repository's package.json,
 *   without its scripts or development dependencies.
 * - README.md: README.npm.md, written for people installing Cairn. The repository's README.md is
 *   for working on it.
 *
 * The repository's own package.json is private, so publishing has to go through this directory.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NPM_PACKAGE, VERSION } from '../src/config/paths.ts';

const OUT_DIR = 'dist/npm';
const SHEBANG = '#!/usr/bin/env node';
const README = 'README.npm.md';
/** Copied to the published manifest when present. Everything else stays in the repository. */
const MANIFEST_FIELDS = ['name', 'version', 'description', 'keywords', 'license', 'author', 'homepage', 'bugs', 'repository', 'type', 'engines', 'dependencies'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown> & { version: string };
if (pkg.version !== VERSION) fail(`package.json version ${pkg.version} does not match VERSION ${VERSION} in src/config/paths.ts`);
// Update checks ask npm about NPM_PACKAGE, so it has to be the name this is published under.
if (pkg.name !== NPM_PACKAGE) fail(`package.json name ${String(pkg.name)} does not match NPM_PACKAGE ${NPM_PACKAGE} in src/config/paths.ts`);
if (!existsSync(README)) fail(`${README} is missing; it becomes the README on npm.`);

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  target: 'node',
  format: 'esm',
  packages: 'external',
});
if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  fail('build failed');
}
const code = await result.outputs[0]!.text();
const body = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code;

// Fresh each time, so nothing left from an earlier build is published.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const cli = join(OUT_DIR, 'cli.js');
writeFileSync(cli, `${SHEBANG}\n${body}`);
chmodSync(cli, 0o755);

const manifest: Record<string, unknown> = {};
for (const field of MANIFEST_FIELDS) if (pkg[field] !== undefined) manifest[field] = pkg[field];
manifest.bin = { cairn: 'cli.js' };
writeFileSync(join(OUT_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

copyFileSync(README, join(OUT_DIR, 'README.md'));
if (existsSync('LICENSE')) copyFileSync('LICENSE', join(OUT_DIR, 'LICENSE'));

console.log(`wrote ${OUT_DIR}/ for ${pkg.name}@${pkg.version} (cli.js ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB)`);
