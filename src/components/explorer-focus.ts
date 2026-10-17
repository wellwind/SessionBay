/** Native menu and capture-phase Cmd+W must respect the focused file layer. */
export function closeFocusedExplorer(): boolean {
  const focused = document.activeElement;
  const pane = focused?.closest<HTMLElement>('.workspace-files-pane');
  const explorer = pane?.querySelector<HTMLElement>('[data-file-explorer]') ?? focused?.closest<HTMLElement>('[data-file-explorer]');
  if (!explorer || explorer.closest('[hidden]') || pane?.style.display === 'none' || explorer.closest<HTMLElement>('.workspace-canvas')?.style.display === 'none') return false;
  explorer.dispatchEvent(new Event('explorer-close-file'));
  return true;
}
