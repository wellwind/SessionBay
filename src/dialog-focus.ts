/** Check at execution time: a modal can open after terminal focus was scheduled. */
export function hasBlockingDialog(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
}
