import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/basic-languages/monaco.contribution';
import { jsonDefaults, getWorker as getJsonWorker } from 'monaco-editor/language/json/monaco.contribution';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// All code and workers are bundled locally. Read-only preview deliberately has no
// language servers, remote schemas, extension host, or CDN loader.
jsonDefaults.setDiagnosticsOptions({ validate: false, enableSchemaRequest: false, schemas: [] });
self.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
export { monaco, getJsonWorker };
