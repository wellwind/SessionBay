import assert from 'node:assert/strict';
import { test } from 'vitest';
import { tauriEnvironment } from './tauri.mjs';

test('Unix prepends rustup without changing inherited environment', () => {
  const env = { PATH: '/usr/bin', KEEP: 'value' };
  assert.deepEqual(tauriEnvironment(env, 'linux', '/home/使用者'), {
    PATH: '/home/使用者/.cargo/bin:/usr/bin', KEEP: 'value',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', KEEP: 'value' });
});

test('Windows preserves Unicode/spaces and uses one case-insensitive PATH', () => {
  const env = { Path: 'C:\\Windows\\System32', PATH: 'ignored duplicate', KEEP: 'value' };
  const result = tauriEnvironment(env, 'win32', 'C:\\Users\\使用者 Name');
  assert.equal(result.Path, 'C:\\Users\\使用者 Name\\.cargo\\bin;C:\\Windows\\System32');
  assert.equal(result.PATH, undefined);
  assert.equal(result.KEEP, 'value');
});

test('Cargo home is honored without shell expansion or argument rewriting', () => {
  assert.equal(tauriEnvironment({ CARGO_HOME: 'D:\\Rust & Tools' }, 'win32', 'C:\\Users\\you').Path,
    'D:\\Rust & Tools\\bin');
  assert.equal(tauriEnvironment({ CARGO_HOME: '/tmp/rust tools', PATH: '/usr/bin' }, 'darwin', '/Users/you').PATH,
    '/tmp/rust tools/bin:/usr/bin');
});

test('only dev receives the identity overlay and release dev is rejected', async () => {
  const { tauriArguments } = await import('./tauri.mjs');
  const dev = tauriArguments(['dev', '--no-watch']);
  assert.equal(dev[0], 'dev');
  assert.equal(dev[1], '--config');
  assert.ok(dev[2].endsWith('/src-tauri/tauri.dev.conf.json'));
  assert.equal(dev[3], '--no-watch');
  for (const args of [['build'], ['build', '--debug'], ['icon', 'path with spaces.svg']]) {
    assert.deepEqual(tauriArguments(args), args);
  }
  assert.throws(() => tauriArguments(['dev', '--release']));
});

test('dev metadata captures branch and commit with an explicit fallback', async () => {
  const { devMetadata } = await import('./tauri.mjs');
  assert.deepEqual(devMetadata(args => args.includes('--abbrev-ref') ? 'feature/identity' : 'abc123def456'), {
    VITE_SESSIONBAY_DEV: '1', VITE_SESSIONBAY_BRANCH: 'feature/identity', VITE_SESSIONBAY_COMMIT: 'abc123def456',
  });
  assert.equal(devMetadata(() => { throw new Error('not a checkout'); }).VITE_SESSIONBAY_COMMIT, 'unknown');
});
