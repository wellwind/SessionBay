import { agentCapabilities } from './agents';
import { pathPlatform, type PathPlatform } from './paths';
import type { AgentKind } from './types';
import { shouldHandleTerminalKey } from './terminal-ime';

export type ShiftEnterEncoding = 'native' | 'csi-u';
export type ShiftEnterMode = 'default' | ShiftEnterEncoding;
export const shiftEnterSequence = '\x1b[13;2u';

/** Launch provenance is a default, never foreground-process or input-mode detection. */
export function defaultShiftEnter(kind: string, platform: PathPlatform = pathPlatform()): ShiftEnterEncoding {
  if (!Object.hasOwn(agentCapabilities, kind)) return 'native';
  return agentCapabilities[kind as AgentKind].keyboard.shiftEnter[platform];
}

/** One-key compatibility binding; do not advertise Kitty/modifyOtherKeys support. */
export function handleTerminalKey(event: KeyboardEvent, options: {
  encoding: ShiftEnterEncoding;
  composing: boolean;
  canInput: boolean;
  blocked: boolean;
  input: (data: string) => void;
}): boolean {
  if (!shouldHandleTerminalKey(event)) return false;
  if (options.blocked || event.defaultPrevented) return false;
  if (options.composing || event.isComposing || event.keyCode === 229) return true;
  if (options.encoding !== 'csi-u' || event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
  // Consume every phase, but emit only on keydown; no fallback CR on keypress.
  event.preventDefault();
  if (event.type === 'keydown' && options.canInput) options.input(shiftEnterSequence);
  return false;
}
