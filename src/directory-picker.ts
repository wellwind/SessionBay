import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t } from './i18n';

export const canPickDirectory = () => isTauri();
let pending = false;

/** Selecting a path never saves settings, starts a process, or scans history. */
export async function pickDirectory(title: string, currentPath: string): Promise<string | null> {
  if (!canPickDirectory()) throw new Error(t('Choose a folder in the Session Bay desktop app, or type the path.'));
  if (pending) throw new Error(t('A folder picker is already open. Finish or cancel it first.'));
  pending = true;
  try {
    const selected = await open({
      title,
      directory: true,
      multiple: false,
      // Do not recursively expand an optional filesystem plugin scope.
      recursive: false,
      ...(currentPath.trim() ? { defaultPath: currentPath.trim() } : {}),
    });
    if (selected === null) return null;
    if (typeof selected !== 'string' || !selected) throw new Error(t('No valid folder path was returned. Type the path instead.'));
    return selected;
  } finally {
    pending = false;
  }
}
