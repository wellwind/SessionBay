/** Task text is data: remove terminal controls before framing it as a safe paste. */
export function taskInputText(title: string, notes: string) {
  return [title, notes].filter(Boolean).join('\n\n').replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- Strip terminal escape/control bytes from task data.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}
