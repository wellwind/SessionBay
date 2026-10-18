#!/usr/bin/env node
// Explicit opt-in only: CLAUDE_BINARY=/absolute/path/to/claude node scripts/test-claude-plugin-runtime.mjs
// Uses an already installed official CLI; never installs, logs in, sends prompts,
// launches a helper or calls a model. The provider's own offline test runtime
// dispatches synthetic events, with every external operation stubbed.
import { spawnSync } from 'node:child_process';
import { constants, accessSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const binary = process.env.CLAUDE_BINARY;
let directory;

function cleanOutput(value) {
  let text = value ?? '';
  for (const [path, label] of [
    [directory, '<temporary-test-root>'],
    [binary, '<CLAUDE_BINARY>'],
    [repository, '<repository>'],
  ]) {
    if (path) text = text.split(path).join(label);
  }
  return text;
}

function run(args, env, timeout) {
  const result = spawnSync(binary, args, {
    cwd: join(directory, 'plugin'),
    env,
    shell: false,
    input: '',
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(cleanOutput(result.stdout));
  if (result.stderr) process.stderr.write(cleanOutput(result.stderr));
  if (result.error) throw new Error(`Claude ${args[0]} could not finish (${result.error.code ?? 'execution error'})`);
  if (result.signal) throw new Error(`Claude ${args[0]} ended on ${result.signal}`);
  if (result.status !== 0) throw new Error(`Claude ${args[0]} exited with status ${result.status}`);
}

try {
  if (process.platform !== 'linux') {
    throw new Error('This validation runner currently supports Linux only.');
  }
  if (!binary || !isAbsolute(binary) || /[\u0000-\u001f\u007f-\u009f]/u.test(binary)) {
    throw new Error('Set CLAUDE_BINARY to the absolute path of an already installed official Claude Code executable.');
  }
  try {
    if (!statSync(binary).isFile()) throw new Error();
    accessSync(binary, constants.X_OK);
  } catch {
    throw new Error('CLAUDE_BINARY must identify an accessible executable file.');
  }
  directory = mkdtempSync(join(tmpdir(), 'sessionbay-claude-runtime-'));
  for (const subdir of ['home', 'config', 'tmp', 'plugin/.claude-plugin', 'plugin/hooks', 'plugin/tests']) {
    mkdirSync(join(directory, subdir), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(directory, 'plugin/.claude-plugin/plugin.json'), JSON.stringify({
    name: 'sessionbay-state', version: '1.0.0', description: 'Isolated lifecycle validation',
  }), { mode: 0o600 });
  writeFileSync(join(directory, 'plugin/hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }), { mode: 0o600 });
  copyFileSync(join(repository, 'src-tauri/src/claude_state_mod.js'), join(directory, 'plugin/hooks/register.js'));
  copyFileSync(join(repository, 'scripts/fixtures/claude-state-runtime/lifecycle.fixture.ts'), join(directory, 'plugin/tests/lifecycle.test.ts'));
  // Construct from scratch: no inherited auth, provider endpoint, config, token,
  // session routing, proxy, executable search path or user settings variables.
  const env = {
    HOME: join(directory, 'home'),
    USERPROFILE: join(directory, 'home'),
    CLAUDE_CONFIG_DIR: join(directory, 'config'),
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_CACHE_HOME: join(directory, 'tmp'),
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'),
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  run(['--version'], env, 10_000);
  run(['plugin', 'validate', '.'], env, 30_000);
  run(['plugin', 'test', '.'], env, 60_000);
  console.log('PASS: official Claude plugin compiler/runtime with synthetic lifecycle events; no real agent turn was tested.');
} catch (error) {
  console.error(`Claude plugin runtime validation failed: ${cleanOutput(error.message)}`);
  process.exitCode = 1;
} finally {
  if (directory) {
    try {
      // This exact directory was returned by mkdtemp above, never by a callback.
      rmSync(directory, { recursive: true, force: true });
    } catch {
      console.error('Could not remove the owned temporary test directory.');
      process.exitCode = 1;
    }
  }
}
