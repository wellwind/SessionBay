import { api, call } from './api';
import { parseWorkspaceImage } from './components/image-reader';

/** Real safe reads, binary IPC and WebKit image decoding under the packaged CSP. */
export async function runFileImageSmoke(root: string): Promise<void> {
  const project = (await api.projects()).find(value => value.path === `${root}/workspaces/harbor`);
  if (!project) throw new Error('Image smoke: synthetic project missing');
  for (const path of ['preview.png', 'preview.svg']) {
    const info = await api.inspectWorkspaceFile(project.id, path);
    if (info.kind !== 'image') throw new Error('Image smoke: signature not detected');
    const image = parseWorkspaceImage(await api.readWorkspaceImage(project.id, path, info.version));
    const url = URL.createObjectURL(image.blob);
    const element = new Image();
    try {
      element.src = url; await element.decode();
      if (element.naturalWidth !== image.width || element.naturalHeight !== image.height) throw new Error('Image smoke: decoded dimensions mismatch');
    } finally { element.removeAttribute('src'); URL.revokeObjectURL(url); }
  }
  await call('frontend_diagnostic', { phase: 'interaction', message: 'file-images-binary-ipc-png-svg-webkit-decode' });
}
