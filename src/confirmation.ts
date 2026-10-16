// Tauri's dialog plugin replaces window.confirm with Promise<boolean> on desktop.
// Keep browser/native results explicit; failed or overlapping prompts never authorize actions.
let pending = false;

export async function confirmAction(message: string): Promise<boolean> {
  if (pending) return false;
  pending = true;
  try {
    return (await window.confirm(message)) === true;
  } catch {
    return false;
  } finally {
    pending = false;
  }
}
