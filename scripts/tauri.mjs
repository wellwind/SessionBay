// Run the package's JavaScript entry point directly: Windows .cmd shims must not
// require a shell or re-interpret CLI arguments. Change only this process's PATH.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const env = tauriEnvironment(process.env, process.platform, homedir());
  if (process.platform === 'win32') {
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];
  }
  Object.assign(process.env, env);
  require('@tauri-apps/cli/tauri.js');
}
