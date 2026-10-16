import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export const canPickDirectory = () => isTauri();
let pending = false;

/** Selecting a path never saves settings, starts a process, or scans history. */
export async function pickDirectory(title: string, currentPath: string): Promise<string | null> {
  if (!canPickDirectory()) throw new Error('請在 Session Bay 桌面應用程式選擇資料夾，或直接輸入路徑。');
  if (pending) throw new Error('已有資料夾選擇視窗開啟，請先完成或取消選取。');
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
    if (typeof selected !== 'string' || !selected) throw new Error('未收到有效的目錄路徑，請直接輸入路徑。');
    return selected;
  } finally {
    pending = false;
  }
}
