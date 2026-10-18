import { api, call } from './api';
import { readWorkspaceText } from './components/file-reader';

/** Real bounded IPC and model creation, exclusively against CI's synthetic project. */
export async function runLargeFileSmoke(root: string): Promise<void> {
  const project = (await api.projects()).find(value => value.path === `${root}/workspaces/harbor`);
  if (!project) throw new Error('Large file smoke: synthetic project missing');
  const { monaco, onPreviewError } = await import('./components/monaco-preview');
  let errors = 0;
  const stopErrors = onPreviewError(() => { errors++; });
  try {
  for (const [path, bytes, range] of [['medium.txt', 1024 * 1024, false], ['big.txt', 21 * 1024 * 1024, false], ['huge.txt', 65 * 1024 * 1024, true]] as const) {
    const started = performance.now();
    const info = await api.inspectWorkspaceFile(project.id, path);
    if (info.sizeBytes !== bytes || info.kind !== 'text') throw new Error('Large file smoke: incorrect metadata');
    const value = await readWorkspaceText(project.id, info, new AbortController().signal, () => {}, range ? 0 : undefined);
    if (value.text.length !== (range ? 1024 * 1024 : bytes) || value.partial !== range)
      throw new Error('Large file smoke: incorrect bounded text');
    const uri = monaco.Uri.parse(`sessionbay-large-smoke:///${path}`);
    const model = monaco.editor.createModel(value.text, 'plaintext', uri);
    try { if (model.getValueLength() !== value.text.length) throw new Error('Large file smoke: model content incomplete'); }
    finally { model.dispose(); }
    if (monaco.editor.getModel(uri) || errors) throw new Error('Large file smoke: model leak or delayed error');
    await call('frontend_diagnostic', { phase: 'interaction', message: `bounded-file:${path}:${Math.round(performance.now() - started)}ms` });
  }
  } finally { stopErrors(); }
  if (errors) throw new Error('Large file smoke: cleanup error');
  await call('frontend_diagnostic', { phase: 'interaction', message: 'bounded-files-preflight-chunks-large-model-range-disposal' });
}
