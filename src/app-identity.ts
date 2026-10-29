// Only the tauri dev launcher injects this flag; Vite's DEV also covers browser previews.
export const isDevBuild = import.meta.env.VITE_SESSIONBAY_DEV === '1' && import.meta.env.DEV;
export const devBranch = import.meta.env.VITE_SESSIONBAY_BRANCH || '';
export const devCommit = import.meta.env.VITE_SESSIONBAY_COMMIT || '';
