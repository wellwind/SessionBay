#!/usr/bin/env node
// Explicit opt-in: OPENCODE_BINARY=/absolute/opencode
// OPENCODE_PLUGIN_DEPENDENCIES=/private/prefix node scripts/test-opencode-plugin-runtime.mjs
// Both inputs must already be installed official 1.19.3 packages. This runner
// never installs, logs in, sends prompts, executes tools, or calls a model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, accessSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const binary = process.env.OPENCODE_BINARY;
const dependencyRoot = process.env.OPENCODE_PLUGIN_DEPENDENCIES;
let directory;

function safeAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function run(args, env, timeout) {
  const result = spawnSync(binary, args, {
    cwd: join(directory, 'workspace'), env, shell: false,
    input: '', encoding: 'utf8', timeout, killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  // Never print merged configuration, raw diagnostics, paths or environment.
  if (result.error) throw new Error(`OpenCode ${args[0]} did not finish (${result.error.code ?? 'execution error'})`);
  if (result.signal) throw new Error(`OpenCode ${args[0]} ended on ${result.signal}`);
  if (result.status !== 0) throw new Error(`OpenCode ${args[0]} exited with status ${result.status}`);
  return result;
}

try {
  if (process.platform !== 'linux') throw new Error('This validation runner supports Linux only.');
  if (!safeAbsolute(binary) || !safeAbsolute(dependencyRoot)) {
    throw new Error('Set absolute OPENCODE_BINARY and OPENCODE_PLUGIN_DEPENDENCIES paths to privately preinstalled official 1.19.3 packages.');
  }
  if (!statSync(binary).isFile()) throw new Error('OPENCODE_BINARY must be an executable file.');
  accessSync(binary, constants.X_OK);
  const modules = realpathSync(join(dependencyRoot, 'node_modules'));
  assert.equal(json(join(modules, '@opencode-ai/plugin/package.json')).version, '1.19.3');
  assert.equal(json(join(modules, '@opencode-ai/sdk/package.json')).version, '1.19.3');
  const packageFile = json(join(dependencyRoot, 'package.json'));
  const lock = json(join(dependencyRoot, 'package-lock.json'));
  assert.equal(packageFile.dependencies?.['@opencode-ai/plugin'], '1.19.3');
  assert.equal(lock.packages?.['']?.dependencies?.['@opencode-ai/plugin'], '1.19.3');
  // Keep the provider's built-in dependency check satisfied without an install.
  // Do not accept a package root containing additional top-level dependencies.
  assert.deepEqual(Object.keys(packageFile.dependencies).sort(), ['@opencode-ai/plugin']);
  for (const key of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(Object.keys(packageFile[key] ?? {}).length, 0);
  }
  directory = mkdtempSync(join(tmpdir(), 'sessionbay-opencode-runtime-'));
  for (const subdir of ['home', 'config/opencode', 'data', 'cache', 'state', 'tmp', 'workspace', 'plugin']) {
    mkdirSync(join(directory, subdir), { recursive: true, mode: 0o700 });
  }
  const config = join(directory, 'config/opencode');
  copyFileSync(join(dependencyRoot, 'package.json'), join(config, 'package.json'));
  copyFileSync(join(dependencyRoot, 'package-lock.json'), join(config, 'package-lock.json'));
  symlinkSync(modules, join(config, 'node_modules'), 'dir');
  const wrapper = join(directory, 'plugin/loader.fixture.mjs');
  copyFileSync(join(repository, 'src-tauri/src/opencode_state_plugin.mjs'), join(directory, 'plugin/sessionbay-state.mjs'));
  copyFileSync(join(repository, 'scripts/fixtures/opencode-state-runtime/loader.fixture.mjs'), wrapper);
  const sentinel = join(directory, 'sentinel.jsonl');
  // Fresh environment: no inherited provider credentials, config, history,
  // session routing, proxy, SSH agent, NODE_OPTIONS or user executable paths.
  const env = {
    HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'),
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(wrapper).href] }),
    SESSIONBAY_HOOK_LAUNCH: randomUUID(), SESSIONBAY_OPENCODE_STATE_HELPER: '/usr/bin/false',
    SESSIONBAY_OPENCODE_STATE_DIRECTORY: join(directory, 'workspace'),
    SESSIONBAY_OPENCODE_STATE_SESSION: '', SESSIONBAY_TEST_SENTINEL: sentinel,
  };
  const version = run(['--version'], env, 10_000).stdout.trim();
  assert.equal(version, '1.19.3', 'This native fixture is pinned to the reviewed official CLI');
  const result = run(['debug', 'config'], env, 30_000);
  const configResult = JSON.parse(result.stdout);
  assert(configResult.plugin.includes(pathToFileURL(wrapper).href));
  const records = readFileSync(sentinel, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [
    { stage: 'loaded', hooks: ['chat.message', 'dispose', 'event'], sourceRegistered: true, disabled: false, root: null, sequence: 0 },
    { stage: 'disposed', hooks: ['chat.message', 'dispose', 'event'], sourceRegistered: true, disabled: true, root: null, sequence: 0 },
  ]);
  console.log(JSON.stringify({
    result: 'PASS', provider: 'OpenCode', version, stages: records.map(record => record.stage),
    hooks: records[0].hooks, stateReports: 0, stderrBytes: Buffer.byteLength(result.stderr),
    scope: 'official CLI plugin load/dispose only; no real agent turn or model call',
  }));
} catch (error) {
  // Assertion details can contain local paths/config, so keep errors categorical.
  const message = error instanceof SyntaxError ? 'Could not parse the native loader fixture.'
    : error.code === 'ERR_ASSERTION' ? 'Native loader contract assertion failed.'
    : typeof error.code === 'string' ? `Validation could not finish (${error.code}).`
      : error.message;
  console.error(`OpenCode plugin runtime validation failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (directory) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch {
      console.error('Could not remove the owned temporary test directory.');
      process.exitCode = 1;
    }
  }
}
