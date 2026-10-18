import { api, call } from './api';

/** Native WebView self-test using the runner's isolated fixture and real IPC. */
export async function runFilesSmoke(): Promise<void> {
  const waitFor = async (condition: () => boolean | Promise<boolean>, description: string) => {
    const deadline = performance.now() + 15000;
    while (!await condition()) {
      if (performance.now() >= deadline) throw new Error(`Files smoke: ${description}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  };
  const click = (button: HTMLButtonElement | null) => {
    if (!button || button.disabled || button.getBoundingClientRect().width <= 0)
      throw new Error('Files smoke: missing visible enabled control');
    button.click();
  };
  const boot = await api.bootstrap();
  const root = boot.settings.profiles.find(p => p.id === 'smoke-shell')?.env.SESSIONBAY_SMOKE_WORKSPACE;
  if (!root || !/^[A-Za-z]:\\.*\\workspace-fixture$/.test(root) || root.includes('..') || boot.settings.sources.length)
    throw new Error('Files smoke: invalid isolated fixture configuration');
  click(document.querySelector<HTMLButtonElement>('button[aria-label="加入專案"]'));
  await waitFor(() => !!document.querySelector('[role="dialog"] input'), 'project form missing');
  const inputs = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input');
  for (const [input, value] of [[inputs[0], root], [inputs[1], 'Synthetic files smoke']] as const) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await waitFor(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button.primary')?.disabled === false, 'project submit disabled');
  click(document.querySelector<HTMLButtonElement>('[role="dialog"] button.primary'));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'project add failed');
  const project = (await api.projects()).find(p => p.name === 'Synthetic files smoke');
  if (!project) throw new Error('Files smoke: project not persisted');
  const projectButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.project-main')).find(b => b.textContent?.includes(project.name));
  click(projectButton ?? null);
  await waitFor(() => !!document.querySelector('button[aria-label="新增工作區分頁"]'), 'project workspace missing');
  click(document.querySelector<HTMLButtonElement>('button[aria-label="新增工作區分頁"]'));
  await waitFor(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button.primary')?.disabled === false, 'shell preview unavailable');
  click(document.querySelector<HTMLButtonElement>('[role="dialog"] button.primary'));
  await waitFor(() => !!document.querySelector('.runtime-dot.running'), 'isolated shell did not start');
  const visibleTerminal = () => Array.from(document.querySelectorAll<HTMLElement>('.xterm-host'))
    .find(element => element.getBoundingClientRect().width > 0 && !!element.querySelector('.xterm-screen'));
  await waitFor(() => !!visibleTerminal(), 'visible terminal did not mount');
  const terminal = visibleTerminal()!;
  const toggle = document.querySelector<HTMLButtonElement>('.workspace-activity[aria-label="Files"]');
  click(toggle);
  await waitFor(() => toggle?.getAttribute('aria-expanded') === 'true', 'Files activity did not open its sidebar');
  await waitFor(() => !!document.querySelector('.project-files-sidebar button[title="hello.txt"]'), 'native directory IPC did not render');
  click(document.querySelector<HTMLButtonElement>('.project-files-sidebar button[title="hello.txt"]'));
  await waitFor(() => document.querySelector('[aria-label="唯讀內容：hello.txt"]')?.textContent?.includes('<literal>安全文字</literal>') === true, 'native text IPC did not render literal content');
  if (document.querySelector('[data-file-explorer] literal') || !terminal.isConnected || !!visibleTerminal())
    throw new Error('Files smoke: content executed or terminal remounted');
  const denied = async (path: string) => {
    try { await api.readWorkspaceFile(project.id, path); } catch { return; }
    throw new Error(`Files smoke: unsafe request accepted: ${path}`);
  };
  for (const path of ['../outside.txt', 'binary.bin', 'hardlink.txt', 'oversize.txt']) await denied(path);
  const page = await api.listWorkspaceFiles(project.id, '');
  if (page.entries.find(e => e.name === 'hardlink.txt')?.kind !== 'blocked')
    throw new Error('Files smoke: hardlink was not blocked in listing');
  click(toggle);
  await waitFor(() => toggle?.getAttribute('aria-expanded') === 'false', 'sidebar did not close');
  if (!document.querySelector('[data-file-explorer]') || !terminal.isConnected)
    throw new Error('Files smoke: sidebar toggle removed document or terminal');
  click(document.querySelector<HTMLButtonElement>('.workspace-tab-select'));
  await waitFor(() => terminal === visibleTerminal(), 'runtime tab did not restore original terminal');
  const runtimes = await api.runtimes();
  if (runtimes.length !== 1 || runtimes[0].kind !== 'shell' || runtimes[0].state !== 'running')
    throw new Error('Files smoke: expected exactly one running isolated shell');
  await call('frontend_diagnostic', { phase: 'interaction', message: 'files:list-text-literal-deny-traversal-binary-hardlink-oversize-sidebar-runtime-identity' });
}
