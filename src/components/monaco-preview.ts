import * as monaco from 'monaco-editor/editor/editor.api';
// Monaco 0.57's lazy JSON worker manager also imports all editor features. Load
// the official registry before the first StandaloneServices initialization: late
// contributions would otherwise request services absent from its snapshot.
import 'monaco-editor/features/register.all';
import { errorHandler } from 'monaco-editor/base/common/errors';
import 'monaco-editor/basic-languages/monaco.contribution';
import { jsonDefaults, getWorker as getJsonWorker } from 'monaco-editor/language/json/monaco.contribution';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// All code and workers are bundled locally. Read-only preview deliberately has no
// language servers, remote schemas, extension host, or CDN loader.
jsonDefaults.setDiagnosticsOptions({ validate: false, enableSchemaRequest: false, schemas: [] });
self.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
export { monaco, getJsonWorker };

const errorListeners = new Set<(error: unknown) => void>();
// Monaco's default handler rethrows delayed contribution failures on window,
// bypassing React boundaries. Keep library failures in the file preview surface.
errorHandler.unexpectedErrorHandler = (error: unknown) => {
  console.error('Monaco preview error', error);
  for (const listener of errorListeners) {
    try { listener(error); }
    catch (failure) { console.error('Monaco preview error containment failed', failure); }
  }
};
export function onPreviewError(listener: (error: unknown) => void): () => void {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}
