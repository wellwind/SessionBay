// Runs every Playwright config in tests/browser/config one after another.
// Usage: npm run test:browser [-- name ...]   (names without .config.ts)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = 'tests/browser/config';
const wanted = process.argv.slice(2);
// The showcase config captures website screenshots rather than testing behavior.
const names = readdirSync(dir).filter(file => file.endsWith('.config.ts')).map(file => file.slice(0, -'.config.ts'.length))
  .filter(name => wanted.length ? wanted.includes(name) : name !== 'showcase');
const failed = [];
for (const name of names) {
  console.log(`\n▶ ${name}`);
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', `${dir}/${name}.config.ts`, '--reporter=line'], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}
console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : `\nAll ${names.length} browser configs passed.`);
process.exit(failed.length ? 1 : 0);
