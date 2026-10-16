/** A modal owns keyboard focus until it closes. */
export function hasBlockingDialog(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
}
