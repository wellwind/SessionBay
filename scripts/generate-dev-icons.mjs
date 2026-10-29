#!/usr/bin/env node
// Derive the dev badge from the padded production SVG without modifying production assets.
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'src-tauri/icons/dev');
const source = await readFile(path.join(root, 'src-tauri/icons/icon-macos.svg'), 'utf8');
// Paths keep the label independent of installed fonts, including in the icon CLI.
const badge = `  <g aria-label="DEV">
    <rect x="232" y="348" width="220" height="102" rx="20" fill="#f97316"/>
    <path d="M254 374H272C305 374 305 424 272 424H254Z M337 374H315V424H337 M315 399H334 M352 374L373 424L394 374"
      transform="translate(18 0)" fill="none" stroke="#19130e" stroke-width="10" stroke-linecap="square" stroke-linejoin="round"/>
  </g>
`;
const svg = source.replace('</svg>', badge + '</svg>');
const temporary = await mkdtemp(path.join(tmpdir(), 'sessionbay-dev-icons-'));
try {
  const input = path.join(temporary, 'icon.svg');
  const generated = path.join(temporary, 'generated');
  await writeFile(input, svg);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/tauri.mjs'), 'icon', input, '--output', generated], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Dev icon generation failed.');
  // Stabilize Tauri's unordered ICNS container, leaving image payloads untouched.
  const icns = await readFile(path.join(generated, 'icon.icns'));
  const entries = [];
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error('Invalid ICNS entry.');
    entries.push(icns.subarray(offset, offset + length));
    offset += length;
  }
  entries.sort((a, b) => a.subarray(0, 4).compare(b.subarray(0, 4)));
  await writeFile(path.join(generated, 'icon.icns'), Buffer.concat([icns.subarray(0, 8), ...entries]));
  const validation = spawnSync('python3', [path.join(root, 'scripts/validate-macos-icon.py'), path.join(generated, 'icon.icns')], { cwd: root, stdio: 'inherit' });
  if (validation.status !== 0) throw new Error('Dev icon padding validation failed.');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'icon.svg'), svg);
  for (const file of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico']) {
    await copyFile(path.join(generated, file), path.join(output, file));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
