import { call } from './api';

/** Native WebKit check: a real bundled worker must reply, not a main-thread fallback. */
export async function runMonacoSmoke(): Promise<void> {
  const { monaco, getJsonWorker, onPreviewError } = await import('./components/monaco-preview');
  const environment = self.MonacoEnvironment;
  if (!environment?.getWorker) throw new Error('Monaco smoke: local worker factory missing');
  const originalFactory = environment.getWorker;
  let replies = 0;
  let errors = 0;
  const listeners: (() => void)[] = [];
  const stopErrors = onPreviewError(() => { errors++; });
  environment.getWorker = async (id, label) => {
    const worker = await originalFactory(id, label);
    const replied = () => { if (label === 'json') replies++; };
    const failed = () => { errors++; };
    worker.addEventListener('message', replied);
    worker.addEventListener('error', failed);
    listeners.push(() => {
      worker.removeEventListener('message', replied);
      worker.removeEventListener('error', failed);
    });
    return worker;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:240px';
  const text = '{"synthetic":true,"value":42}';
  const uri = monaco.Uri.parse('sessionbay-smoke:///worker.json');
  let model: ReturnType<typeof monaco.editor.createModel> | undefined;
  let editor: ReturnType<typeof monaco.editor.create> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    document.body.append(host);
    model = monaco.editor.createModel(text, 'json', uri);
    editor = monaco.editor.create(host, { model, readOnly: true, domReadOnly: true });
    await Promise.race([
      (async () => {
        let factory: Awaited<ReturnType<typeof getJsonWorker>> | undefined;
        const deadline = performance.now() + 10000;
        while (!factory && performance.now() < deadline) {
          try { factory = await getJsonWorker(); }
          catch (error) {
            if (error !== 'JSON not registered!') throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        }
        if (!factory) throw new Error('Monaco smoke: JSON mode did not initialize');
        const proxy = await factory(uri);
        await proxy.doValidation(uri.toString());
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Monaco smoke: worker timed out')), 15000);
      }),
    ]);
    editor.dispose();
    editor = monaco.editor.create(host, { model, readOnly: true, domReadOnly: true });
    editor.focus();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    if (!replies || errors) throw new Error('Monaco smoke: worker/contribution failed or silently fell back');
    editor.trigger('native-smoke', 'type', { text: 'MUST_NOT_INSERT' });
    if (model.getValue() !== text) throw new Error('Monaco smoke: readonly content changed');
  } finally {
    clearTimeout(timeout);
    editor?.dispose();
    model?.dispose();
    host.remove();
    environment.getWorker = originalFactory;
    listeners.forEach((remove) => remove());
    stopErrors();
  }
  if (monaco.editor.getModel(uri)) throw new Error('Monaco smoke: model leaked');
  await call('frontend_diagnostic', { phase: 'interaction', message: 'monaco-worker-readonly-disposal' });
}
