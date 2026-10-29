// Run the package's JavaScript entry point directly: Windows .cmd shims must not
// require a shell or re-interpret CLI arguments. Change only this process's PATH.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tauriEnvironment(env, platform, home) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const result = { ...env };
  const pathKey = platform === 'win32'
    ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH';
  const currentPath = env[pathKey] || '';
  if (platform === 'win32') {
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key];
  }
  const cargoHome = env.CARGO_HOME || paths.join(home, '.cargo');
  result[pathKey] = [paths.join(cargoHome, 'bin'), currentPath].filter(Boolean).join(paths.delimiter);
  return result;
}

export function tauriArguments(args) {
  if (args[0] !== 'dev') return [...args];
  if (args.includes('--release')) throw new Error('The dev profile requires a debug build. Use tauri build for releases.');
  return ['dev', '--config', path.join(root, 'src-tauri/tauri.dev.conf.json'), ...args.slice(1)];
}

export function devMetadata(readGit = (args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim()) {
  const read = (args) => { try { return readGit(args) || 'unknown'; } catch { return 'unknown'; } };
  return {
    VITE_SESSIONBAY_DEV: '1',
    VITE_SESSIONBAY_BRANCH: read(['rev-parse', '--abbrev-ref', 'HEAD']),
    VITE_SESSIONBAY_COMMIT: read(['rev-parse', '--short=12', 'HEAD']),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const env = tauriEnvironment(process.env, process.platform, homedir());
  if (process.platform === 'win32') {
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];
  }
  const args = process.argv.slice(2);
  // Clear inherited metadata so build never accidentally adopts the dev UI.
  for (const key of ['VITE_SESSIONBAY_DEV', 'VITE_SESSIONBAY_BRANCH', 'VITE_SESSIONBAY_COMMIT']) delete env[key];
  const cliArgs = tauriArguments(args);
  if (args[0] === 'dev') Object.assign(env, devMetadata());
  for (const key of ['VITE_SESSIONBAY_DEV', 'VITE_SESSIONBAY_BRANCH', 'VITE_SESSIONBAY_COMMIT']) delete process.env[key];
  Object.assign(process.env, env);
  process.argv.splice(2, process.argv.length - 2, ...cliArgs);
  require('@tauri-apps/cli/tauri.js');
}
