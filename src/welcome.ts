/** First-launch welcome flag. Kept in localStorage so dismissing with "Set up later"
 * (which does not complete onboarding) never re-shows the welcome wizard. */
export const welcomeStorageKey = 'sessionbay.welcome.v1';
export function hasSeenWelcome(): boolean {
  try { return localStorage.getItem(welcomeStorageKey) === 'seen'; } catch { return false; }
}
export function markWelcomeSeen(): void {
  try { localStorage.setItem(welcomeStorageKey, 'seen'); } catch { /* storage unavailable: best effort */ }
}
/** The welcome wizard only appears on the very first launch. */
export function shouldShowWelcome(onboardingComplete: boolean): boolean {
  return !onboardingComplete && !hasSeenWelcome();
}
