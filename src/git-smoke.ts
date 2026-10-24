import { api, call } from './api';

/** Native WebView Git self-test over the runner's synthetic repository and real IPC. */
export async function runGitSmoke(): Promise<void> {
  const fail = (message: string): never => { throw new Error(`Git smoke: ${message}`); };
  const waitFor = async <T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, description: string): Promise<T> => {
    const deadline = performance.now() + 20000;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (performance.now() >= deadline) fail(description);
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  };
  const visible = (element: Element | null) => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const click = (element: Element | null | undefined, what: string) => {
    if (!(element instanceof HTMLElement) || (element as HTMLButtonElement).disabled || !visible(element)) fail(`missing visible enabled ${what}`);
    (element as HTMLElement).click();
  };
  const buttonByText = (scope: ParentNode, text: string) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim().startsWith(text));
  const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const boot = await api.bootstrap();
  const repoPath = boot.settings.profiles.find(profile => profile.id === 'smoke-shell')?.env.SESSIONBAY_SMOKE_GIT_REPO;
  if (!repoPath || !/[\\/]git-fixture$/.test(repoPath) || repoPath.includes('..')) fail('invalid isolated repository configuration');
  const runtimesBefore = (await api.runtimes()).length;

  click(document.querySelector('button[aria-label="加入專案"]'), 'add project button');
  const inputs = await waitFor(() => {
    const found = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input');
    return found.length >= 2 && found;
  }, 'project form missing');
  setValue(inputs[0], repoPath!);
  setValue(inputs[1], 'Synthetic git smoke');
  await waitFor(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button.primary')?.disabled === false, 'project submit disabled');
  click(document.querySelector('[role="dialog"] button.primary'), 'project submit');
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'project add failed');
  const project = (await api.projects()).find(item => item.name === 'Synthetic git smoke') ?? fail('project not persisted');
  click(Array.from(document.querySelectorAll('.project-main')).find(item => item.textContent?.includes(project.name)), 'project entry');

  const toggle = await waitFor(() => document.querySelector<HTMLButtonElement>('.workspace-activity[aria-label="Git"]'), 'Git activity missing');
  click(toggle, 'Git activity');
  const sidebar = await waitFor(() => {
    const element = document.querySelector('.git-sidebar:not([hidden])');
    return element?.querySelector('[role="radio"][aria-checked="true"]') && element;
  }, 'native discovery IPC did not render the repository');
  if (sidebar.getBoundingClientRect().width < 160) fail('Git panel too narrow in native layout');
  const repo = await call<{ state: string; repos: { id: string; name: string }[] }>('git_request', { projectId: project.id, request: { op: 'discover' } });
  const repoId = repo.repos[0]?.id ?? fail('discover returned no repository');

  click(await waitFor(() => sidebar.querySelector('button[aria-label^="f.txt，已修改"]'), 'unstaged change missing'), 'f.txt change');
  const documentRoot = await waitFor(() => document.querySelector('.git-document:not([hidden])'), 'diff document missing');
  click(await waitFor(() => documentRoot.querySelector('[role="checkbox"][aria-label="選取刪除第 4 行"]'), 'line checkbox missing'), 'deleted line 4');
  click(documentRoot.querySelector('[role="checkbox"][aria-label="選取新增第 4 行"]'), 'added line 4');
  click(await waitFor(() => buttonByText(documentRoot, '暫存所選 2 行'), 'stage button missing'), 'stage selection');
  await waitFor(() => documentRoot.textContent?.includes('已暫存所選 2 行。'), 'partial stage did not report success');
  const staged = await call<{ hunks: { lines: { kind: string; text: string }[] }[] }>('git_request', {
    projectId: project.id, request: { op: 'diff', repoId, path: 'f.txt', source: { kind: 'staged' } },
  });
  const added = staged.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add').map(line => line.text);
  if (added.join(',') !== 'DELTA') fail(`index holds unexpected staged lines: ${added.join(',')}`);

  setValue(await waitFor(() => sidebar.querySelector<HTMLTextAreaElement>('textarea'), 'commit message box missing'), 'Native smoke commit');
  click(await waitFor(() => { const button = buttonByText(sidebar, '檢視並 Commit'); return button && !button.disabled && button; }, 'commit preview disabled'), 'commit preview');
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'commit dialog missing');
  click(buttonByText(dialog, '建立 commit'), 'create commit');
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'commit did not finish');
  const log = await call<{ commits: { subject: string }[] }>('git_request', { projectId: project.id, request: { op: 'log', repoId, filter: {}, offset: 0, limit: 5 } });
  if (log.commits[0]?.subject !== 'Native smoke commit') fail('commit not recorded');

  click(await waitFor(() => buttonByText(sidebar, '開啟歷史 graph'), 'graph button missing'), 'open graph');
  await waitFor(() => Array.from(document.querySelectorAll('.git-graph-cell')).filter(visible).length >= 2, 'graph lanes did not paint');

  if ((await api.runtimes()).length !== runtimesBefore) fail('Git tools launched a runtime');
  await call('frontend_diagnostic', { phase: 'interaction', message: 'git:discover-diff-partial-stage-commit-graph' });
}
