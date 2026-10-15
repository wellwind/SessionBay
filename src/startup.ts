import { call } from './api';

// The dependency-free observer is a classic script loaded before any app modules.
declare global {
  interface Window {
    SessionBaySmokeProbe?: () => Promise<void>;
    SessionBayStartup?: {
      moduleLoaded: () => void;
      mounted: () => void;
      ready: () => void;
      interaction: () => void;
      error: (message: string) => void;
      backendError: (message: string) => void;
    };
  }
}
export type SmokeSnapshot = `${'projects' | 'directories' | 'providers' | 'launcher' | 'calendar'}-${'dark' | 'light'}`;
export const smokeSnapshotHoldMs = 6000;

/** Only the backend-enabled smoke probe uses this bounded, allowlisted diagnostic. */
export async function smokeSnapshot(name: SmokeSnapshot): Promise<void> {
  if (!/^(projects|directories|providers|launcher|calendar)-(dark|light)$/.test(name))
    throw new Error('UI smoke: invalid snapshot name');
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const enabled = await call<boolean>('frontend_diagnostic', { phase: 'snapshot', message: name });
  if (enabled !== true) throw new Error('UI smoke: snapshot was not acknowledged by the backend');
  // CI captures painted native pixels while this exact state is held. No runtime is launched.
  await new Promise<void>((resolve) => setTimeout(resolve, smokeSnapshotHoldMs));
}
export const startup = {
  moduleLoaded: () => window.SessionBayStartup?.moduleLoaded(),
  mounted: () => window.SessionBayStartup?.mounted(),
  ready: () => window.SessionBayStartup?.ready(),
  backendError: (message: string) => window.SessionBayStartup?.backendError(message),
  error: (error: unknown) =>
    window.SessionBayStartup?.error(error instanceof Error ? error.message : String(error)),
};
