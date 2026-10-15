#!/usr/bin/env node
// Requires the existing npm dependencies and Python 3, with no extra packages.
// Usage: node scripts/generate-macos-icon.mjs [--preview-dir /absolute/outside/repo]
// The 412/512 artwork scale is an optical choice, not an Apple platform rule.
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'src-tauri', 'icons');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--preview-dir')) {
  throw new Error('Usage: node scripts/generate-macos-icon.mjs [--preview-dir /absolute/outside/repo]');
}
const preview = args.length ? path.resolve(args[1]) : null;
if (preview) {
  const relative = path.relative(root, preview);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Preview output must be outside the repository.');
  }
}

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function protectedAssets() {
  const result = {};
  for (const entry of (await readdir(icons, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || ['icon.icns', 'icon-macos.svg'].includes(entry.name)) continue;
    result[entry.name] = createHash('sha256').update(await readFile(path.join(icons, entry.name))).digest('hex');
  }
  return JSON.stringify(result);
}

function stableIcnsOrder(data) {
  // Tauri emits its image entries in map order. Sort only the container entries
  // for byte-reproducible builds; all encoded image/mask payloads stay untouched.
  if (data.length < 8 || data.toString('ascii', 0, 4) !== 'icns' || data.readUInt32BE(4) !== data.length) {
    throw new Error('Invalid generated ICNS container.');
  }
  const entries = [];
  for (let offset = 8; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('Truncated ICNS entry.');
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) throw new Error('Invalid ICNS entry length.');
    entries.push(data.subarray(offset, offset + length));
    offset += length;
  }
  entries.sort((a, b) => a.subarray(0, 4).compare(b.subarray(0, 4)));
  return Buffer.concat([data.subarray(0, 8), ...entries]);
}

// Invoke only the already installed CLI: npm run does not fetch dependencies.
await access(path.join(root, 'node_modules', '.bin', 'tauri'));
const before = await protectedAssets();
const source = await readFile(path.join(icons, 'icon.svg'), 'utf8');
const match = source.match(/^(<svg\b[^>]*>)([\s\S]*)<\/svg>\s*$/);
if (!match || !/\bwidth="512"/.test(match[1]) || !/\bheight="512"/.test(match[1]) || !/\bviewBox="0 0 512 512"/.test(match[1])) {
  throw new Error('Expected the original 512×512 SVG; review optical padding before changing its canvas.');
}
// Keep every original artwork element and attribute; only wrap them in a transform.
const artwork = match[2].trim().split(/\r?\n/).map((line) => `    ${line.trimStart()}`).join('\n');
const padded = `${match[1]}\n  <!-- macOS optical padding: preserve the original artwork at 412/512 scale. -->\n  <g transform="translate(50 50) scale(0.8046875)">\n${artwork}\n  </g>\n</svg>\n`;
const temporary = await mkdtemp(path.join(tmpdir(), 'sessionbay-macos-icon-'));
try {
  const input = path.join(temporary, 'icon-macos.svg');
  const output = path.join(temporary, 'generated');
  await writeFile(input, padded);
  run('npm', ['run', 'tauri', '--', 'icon', input, '--output', output]);
  const generatedIcon = path.join(output, 'icon.icns');
  await writeFile(generatedIcon, stableIcnsOrder(await readFile(generatedIcon)));
  run('python3', [path.join(root, 'scripts', 'validate-macos-icon.py'), generatedIcon]);
  if (before !== await protectedAssets()) throw new Error('A non-macOS icon asset changed during generation.');

  if (preview) {
    const originalOutput = path.join(temporary, 'original');
    run('npm', ['run', 'tauri', '--', 'icon', path.join(icons, 'icon.svg'), '--output', originalOutput, '--png', '512']);
    await mkdir(preview, { recursive: true });
    // Both previews come from SVG renders, never from editing an existing bitmap.
    await copyFile(path.join(originalOutput, '512x512.png'), path.join(preview, 'before.png'));
    await copyFile(path.join(output, 'icon.png'), path.join(preview, 'after.png'));
  }
  await writeFile(path.join(icons, 'icon-macos.svg'), padded);
  await copyFile(generatedIcon, path.join(icons, 'icon.icns'));
  if (before !== await protectedAssets()) throw new Error('A non-macOS icon asset changed.');
  console.log('Updated icon-macos.svg and icon.icns; all other icon assets are byte-for-byte unchanged.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
