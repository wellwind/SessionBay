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
