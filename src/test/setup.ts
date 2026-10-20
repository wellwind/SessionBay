import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
// jsdom has no layout engine. Geometry/observer tests provide explicit callbacks;
// ordinary App tests only need the browser API to exist during mounting.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(cleanup);
