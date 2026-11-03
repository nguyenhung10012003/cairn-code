/**
 * Builds the npm package's entry point: one ES module for Node, with the
 * dependencies left as imports so npm installs them. The source shebang runs
 * Bun, so it is swapped for a Node one.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../src/config/paths.ts';

const OUTFILE = 'dist/cli.js';
const SHEBANG = '#!/usr/bin/env node';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
if (pkg.version !== VERSION) {
  console.error(`package.json version ${pkg.version} does not match VERSION ${VERSION} in src/config/paths.ts`);
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  target: 'node',
  format: 'esm',
  packages: 'external',
});
if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  console.error('build failed');
  process.exit(1);
}

const code = await result.outputs[0]!.text();
const body = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code;
mkdirSync(dirname(OUTFILE), { recursive: true });
writeFileSync(OUTFILE, `${SHEBANG}\n${body}`);
chmodSync(OUTFILE, 0o755);
console.log(`wrote ${OUTFILE} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB)`);
