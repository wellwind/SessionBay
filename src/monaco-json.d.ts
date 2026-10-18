// Monaco 0.57's compatibility contribution re-exports runtime defaults but does
// not ship a declaration for this subpath. Keep this narrow to the API we use.
declare module 'monaco-editor/language/json/monaco.contribution' {
  export function getWorker(): Promise<(uri: unknown) => Promise<{ doValidation(uri: string): Promise<unknown[]> }>>;
  export const jsonDefaults: {
    setDiagnosticsOptions(options: { validate: boolean; enableSchemaRequest: boolean; schemas: never[] }): void;
  };
}
