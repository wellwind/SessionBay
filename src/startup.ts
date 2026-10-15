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
export const startup = {
  moduleLoaded: () => window.SessionBayStartup?.moduleLoaded(),
  mounted: () => window.SessionBayStartup?.mounted(),
  ready: () => window.SessionBayStartup?.ready(),
  backendError: (message: string) => window.SessionBayStartup?.backendError(message),
  error: (error: unknown) =>
    window.SessionBayStartup?.error(error instanceof Error ? error.message : String(error)),
};
