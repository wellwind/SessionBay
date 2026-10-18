// Loaded by the official CLI, surrounding the unchanged staged production plugin.
// No synthetic state events are injected here: this proves native loading only.
import plugin from './sessionbay-state.mjs';
import { appendFileSync } from 'node:fs';

export default async function validateLoader(input) {
  const hooks = await plugin(input);
  const snapshot = stage => {
    const state = globalThis[Symbol.for('sessionbay.opencode.state.v1')]
      ?.get(process.env.SESSIONBAY_HOOK_LAUNCH);
    appendFileSync(process.env.SESSIONBAY_TEST_SENTINEL, JSON.stringify({
      stage, hooks: Object.keys(hooks).sort(),
      sourceRegistered: Boolean(state),
      disabled: state?.disabled,
      root: state?.root,
      sequence: state?.sequence,
    }) + '\n');
  };
  snapshot('loaded');
  return {
    ...hooks,
    dispose: async () => {
      await hooks.dispose?.();
      snapshot('disposed');
    },
  };
}
