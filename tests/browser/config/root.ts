import { fileURLToPath } from 'node:url';

// Configs live in tests/browser/config; paths and web servers resolve from the repo root.
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const testDir = fileURLToPath(new URL('../', import.meta.url));
export const output = (name: string) => `${root}${name}`;
