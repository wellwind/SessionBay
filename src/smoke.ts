import { agentKinds, agentNames } from './agents';
import { smokeSnapshot } from './startup';

/** Invoked only after the native diagnostic command confirms SESSIONBAY_SMOKE=1. */
export async function runSmokeInteraction(): Promise<void> {
  const dialog = () => document.querySelector<HTMLElement>('.settings-panel[role="dialog"]');
  const waitFor = (condition: () => boolean, description: string): Promise<void> => {
    const deadline = performance.now() + 15000;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (condition()) resolve();
        else if (performance.now() >= deadline) reject(new Error(`UI smoke: ${description}`));
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  };
  const click = (button: HTMLElement | null) => {
    if (!button || button.matches(':disabled, [aria-disabled="true"]') || button.getBoundingClientRect().width <= 0)
      throw new Error('UI smoke: expected a visible, enabled control');
    button.focus({ preventScroll: true });
    button.click();
  };
  const selectAgent = async (kind: (typeof agentKinds)[number]) => {
    const name = agentNames[kind];
    click(dialog()?.querySelector<HTMLButtonElement>(`button[data-agent-kind="${kind}"]`) ?? null);
    await waitFor(() => dialog()?.querySelector(`button[data-agent-kind="${kind}"]`)?.getAttribute('aria-pressed') === 'true' &&
      !!dialog()?.querySelector(`[aria-label="${name} 歷史來源"]`), `${name} settings did not open`);
    if (dialog()!.querySelectorAll('.settings-history-provider').length !== 1 ||
      dialog()!.querySelectorAll('.settings-installation').length !== 1)
      throw new Error(`UI smoke: expected only selected ${name} configuration`);
  };
  const close = () =>
    click(dialog()?.querySelector<HTMLButtonElement>(
      'button[aria-label="稍後設定"], button[aria-label="關閉設定"]',
    ) ?? null);
  const open = () => click(document.querySelector<HTMLButtonElement>(
    'button[aria-label="設定與資料來源"]',
  ));
  if (dialog()) {
    close();
    await waitFor(() => !dialog(), 'initial settings dialog did not dismiss');
  }
  open();
  await waitFor(() => !!dialog(), 'settings dialog did not open');
  close();
  await waitFor(() => !dialog(), 'settings dialog did not close');
  open();
  await waitFor(() => !!dialog(), 'settings dialog did not reopen');
  // Only CI's reserved synthetic source opts into the richer scenario. Ordinary empty-HOME
  // smoke retains its no-write contract; a real source cannot supply an arbitrary target path.
  const fixtureSource = dialog()?.querySelector<HTMLInputElement>('#source-root-sessionbay-smoke-codex')?.value;
  if (fixtureSource && (!fixtureSource.startsWith('/') || fixtureSource.includes('/../') ||
    !fixtureSource.endsWith('/sessionbay-smoke-fixture/codex')))
    throw new Error('UI smoke: invalid synthetic fixture source');
  const fixtureRoot = fixtureSource?.slice(0, -'/codex'.length);
  for (const kind of agentKinds) {
    const name = agentNames[kind];
    await selectAgent(kind);
    const checkbox = dialog()?.querySelector<HTMLInputElement>(`input[aria-label="${name} 略過權限確認"]`);
    if (!checkbox || checkbox.checked) throw new Error(`UI smoke: missing/default-unsafe ${name} options`);
  }
  close();
  await waitFor(() => !dialog(), 'settings dialog did not dismiss before project navigation');
  const projectDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="加入或建立專案"]');
  const openProject = () => click(document.querySelector<HTMLButtonElement>('button[aria-label="加入專案"]'));
  const projectButton = (label: string) => Array.from(projectDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((button) => button.textContent?.trim() === label) ?? null;
  if (document.querySelector('h1')?.textContent !== '專案')
    throw new Error('UI smoke: curated Projects is not the default navigation page');
  if (document.querySelector('nav[aria-label="專案"] .project-row'))
    throw new Error('UI smoke: blank HOME unexpectedly contains curated projects');
  click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
  await waitFor(() => document.querySelector('h1')?.textContent === '所有目錄', 'directory navigation page did not open');
  if (!document.querySelector('[aria-label="所有目錄總覽"]') || document.querySelector('#session-search'))
    throw new Error('UI smoke: directory overview was replaced by a mixed-session list');
  click(document.querySelector<HTMLButtonElement>('#navigation-projects'));
  await waitFor(() => document.querySelector('h1')?.textContent === '專案', 'project management page did not reopen');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not open');
  click(projectButton('建立新專案'));
  await waitFor(() => !!projectButton('建立並加入'), 'create project mode did not open');
  click(projectButton('取消'));
  await waitFor(() => !projectDialog(), 'project dialog did not cancel');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not reopen');
  // Form state must reset after cancel, and no create/add command is submitted.
  await waitFor(() => projectButton('加入現有目錄')?.classList.contains('selected') === true,
    'cancelled project creation leaked into the next dialog');
  click(projectButton('建立新專案'));
  await waitFor(() => !!projectButton('建立並加入'), 'create project mode did not reopen');
  if (fixtureRoot) {
    click(projectButton('取消'));
    await waitFor(() => !projectDialog(), 'project dialog did not dismiss before fixture setup');
    const setInput = (input: HTMLInputElement | null, value: string) => {
      if (!input) throw new Error('UI smoke: missing fixture form input');
      // Use the platform setter so React observes the same input event as user typing.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const [directory, name] of [['harbor', 'Harbor Console'], ['notes', 'Field Notes']]) {
      openProject();
      await waitFor(() => !!projectDialog(), 'fixture project dialog did not open');
      const inputs = projectDialog()!.querySelectorAll<HTMLInputElement>('input');
      setInput(inputs[0], `${fixtureRoot}/workspaces/${directory}`);
      setInput(inputs[1], name);
      await waitFor(() => projectButton('加入專案')?.disabled === false, 'fixture project submit did not enable');
      click(projectButton('加入專案'));
      await waitFor(() => !projectDialog(), 'fixture project could not be added');
    }
    click(document.querySelector<HTMLButtonElement>('button[aria-label="更新索引"]'));
    click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
    await waitFor(() => document.querySelectorAll('[aria-label="所有目錄總覽"] button[aria-label^="瀏覽目錄 "]').length >= 4,
      'synthetic histories were not indexed into four directory groups');
    const theme = document.documentElement.dataset.theme;
    if (theme !== 'dark' && theme !== 'light') throw new Error('UI smoke: fixture theme must be explicit');
    click(document.querySelector<HTMLButtonElement>('#navigation-projects'));
    await waitFor(() => document.querySelector('h1')?.textContent === '專案', 'fixture projects overview did not open');
    await smokeSnapshot(`projects-${theme}`);
    click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
    await waitFor(() => document.querySelector('h1')?.textContent === '所有目錄', 'fixture directory overview did not open');
    if (!document.querySelector('[aria-label="所有目錄總覽"]')?.textContent?.includes('未記錄工作目錄'))
      throw new Error('UI smoke: unknown directory group is missing');
    await smokeSnapshot(`directories-${theme}`);
    open();
    await waitFor(() => !!dialog(), 'provider settings did not open');
    if (dialog()!.querySelectorAll('button[data-agent-kind]').length !== agentKinds.length)
      throw new Error('UI smoke: expected all providers in the settings picker');
    for (const kind of agentKinds) await selectAgent(kind);
    await selectAgent('codex');
    dialog()!.querySelector('.settings-agent-picker')?.scrollIntoView({ block: 'start' });
    await smokeSnapshot(`providers-${theme}`);
    // Exercise the native read-only discovery IPC against CI's isolated, empty GROK_HOME.
    // Merely finding a candidate must not add a draft source or launch a runtime.
    const sourceRoots = async () => {
      const selected = dialog()!.querySelector<HTMLButtonElement>('button[data-agent-kind][aria-pressed="true"]')!
        .dataset.agentKind as (typeof agentKinds)[number];
      const roots: string[] = [];
      for (const kind of agentKinds) {
        await selectAgent(kind);
        roots.push(...Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[id^="source-root-"]')).map((input) => input.value));
      }
      await selectAgent(selected);
      return roots;
    };
    await selectAgent('grok');
    const rootsBeforeDetection = await sourceRoots();
    click(dialog()!.querySelector<HTMLButtonElement>('button[aria-label="偵測 Grok Build 歷史來源"]'));
    const grokHistory = () => dialog()?.querySelector<HTMLElement>('[aria-label="Grok Build 歷史來源"]');
    await waitFor(() => !!grokHistory()?.querySelector('.settings-source-candidate') &&
      !grokHistory()?.querySelector<HTMLButtonElement>('button[aria-label="偵測 Grok Build 歷史來源"]')?.matches(':disabled'),
    'Grok history discovery did not resolve');
    const readableGrokCandidate = Array.from(grokHistory()!.querySelectorAll<HTMLElement>('.settings-source-candidate'))
      .find((candidate) => candidate.querySelector('.settings-status')?.textContent === '找到可讀目錄');
    if (!readableGrokCandidate?.querySelector<HTMLButtonElement>('button[aria-label^="加入 Grok Build 偵測來源 "]') ||
      readableGrokCandidate.querySelector<HTMLButtonElement>('button')?.disabled ||
      JSON.stringify(await sourceRoots()) !== JSON.stringify(rootsBeforeDetection) ||
      grokHistory()!.querySelector('.settings-source') || document.querySelector('.workspace-tab, .xterm-host'))
      throw new Error('UI smoke: history discovery must offer the empty Grok root without adding a source or launching work');
    close();
    await waitFor(() => !dialog(), 'provider settings did not close');
    click(document.querySelector<HTMLButtonElement>('button[aria-label="瀏覽目錄 Harbor Console"]'));
    await waitFor(() => !!document.querySelector('#session-search'), 'fixture scoped history did not open');
    const buttonByText = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === label) ?? null;
    // Open only: never submit the new-work launcher or start a shell/Agent process.
    click(buttonByText('新增工作'));
    const launcher = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="開始新的工作"]');
    await waitFor(() => !!launcher(), 'fixture launcher did not open');
    click(Array.from(launcher()!.querySelectorAll<HTMLButtonElement>('[aria-label="工作類型"] button'))
      .find((button) => button.textContent?.startsWith('Shell')) ?? null);
    await waitFor(() => !!launcher()?.querySelector('[aria-label="啟動參數預覽"] pre'),
      'fixture shell preview did not resolve');
    click(Array.from(launcher()!.querySelectorAll<HTMLButtonElement>('[aria-label="工作類型"] button'))
      .find((button) => button.textContent?.startsWith('Agent')) ?? null);
    await waitFor(() => !!launcher()?.querySelector('[role="combobox"][aria-label="Agent"]'),
      'fixture agent chooser did not appear');
    click(launcher()!.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Agent"]'));
    await waitFor(() => launcher()?.querySelectorAll('[role="listbox"] [role="option"]').length === agentKinds.length,
      'provider listbox did not open inside the launcher dialog');
    if (launcher()!.querySelectorAll('[role="option"][aria-disabled="true"]').length !== agentKinds.length)
      throw new Error('UI smoke: synthetic unavailable executables must remain disabled');
    await smokeSnapshot(`launcher-${theme}`);
    launcher()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('[role="listbox"]'), 'fixture agent chooser did not dismiss');
    if (!launcher()) throw new Error('UI smoke: dismissing the chooser also closed the launcher');
    launcher()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !launcher(), 'fixture launcher did not dismiss');
    click(buttonByText('篩選'));
    await waitFor(() => !!document.querySelector('button[aria-label="開始日期，開啟日曆"]'), 'history date filter did not appear');
    // Pick a stable month for deterministic screenshots without filtering the fixture history.
    const dateInput = document.querySelector<HTMLInputElement>('input[aria-label="開始日期"]');
    dateInput?.focus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    setInput(dateInput, '2026-01-01');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    dateInput?.blur();
    click(document.querySelector<HTMLButtonElement>('button[aria-label="開始日期，開啟日曆"]'));
    await waitFor(() => !!document.querySelector('[role="dialog"][aria-label="選擇開始日期"] [role="grid"]'),
      'history calendar did not open');
    await smokeSnapshot(`calendar-${theme}`);
    document.querySelector<HTMLElement>('[role="dialog"][aria-label="選擇開始日期"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('[role="dialog"][aria-label="選擇開始日期"]'),
      'fixture calendar did not dismiss');
    // Keep the five screenshot states stable; verify the new CLI reader through
    // the real UI and IPC only after the final snapshot has been captured.
    open();
    await waitFor(() => !!dialog(), 'settings did not reopen for CLI history discovery');
    await selectAgent('antigravity');
    const antigravityRootsBefore = await sourceRoots();
    click(dialog()!.querySelector<HTMLButtonElement>('button[aria-label="偵測 Antigravity CLI 歷史來源"]'));
    const antigravityHistory = () => dialog()?.querySelector<HTMLElement>('[aria-label="Antigravity CLI 歷史來源"]');
    await waitFor(() => !!antigravityHistory()?.querySelector('.settings-source-candidate') &&
      !antigravityHistory()?.querySelector<HTMLButtonElement>('button[aria-label="偵測 Antigravity CLI 歷史來源"]')?.matches(':disabled'),
    'Antigravity CLI history discovery did not resolve');
    const nativeCandidate = Array.from(antigravityHistory()!.querySelectorAll<HTMLElement>('.settings-source-candidate'))
      .find((candidate) => candidate.querySelector('code')?.textContent?.endsWith('/.gemini/antigravity-cli'));
    if (nativeCandidate?.querySelector('.settings-status')?.textContent !== '找到可讀目錄' ||
      !nativeCandidate.querySelector<HTMLButtonElement>('button[aria-label^="加入 Antigravity CLI 偵測來源 "]')?.disabled ||
      JSON.stringify(await sourceRoots()) !== JSON.stringify(antigravityRootsBefore))
      throw new Error('UI smoke: native CLI discovery must recognize its configured synthetic root without mutating sources');
    close();
    await waitFor(() => !dialog(), 'CLI discovery settings did not close without saving');
    click(document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="篩選 Agent"]'));
    await waitFor(() => !!document.querySelector('[role="listbox"][aria-label="篩選 Agent"]'),
      'history Agent filter did not open');
    click(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.querySelector('.select-option-copy > span')?.textContent === 'Antigravity CLI') ?? null);
    // The newest native fixture is already Antigravity, so its preview can be
    // present before filtering. Wait for the asynchronous list commit as well.
    await waitFor(() => {
      const list = document.querySelector('[aria-label="Session 清單"]');
      const badges = Array.from(list?.querySelectorAll('.session-card .agent-badge') ?? []);
      return list?.getAttribute('aria-busy') === 'false' && badges.length > 0 &&
        badges.every((badge) => badge.textContent === 'Antigravity CLI');
    }, 'Antigravity CLI filter did not commit a nonempty CLI-only session list');
    await waitFor(() => document.querySelector('[aria-label="對話預覽"]')?.textContent?.includes('SESSIONBAY_SYNTHETIC_AG_USER') === true &&
      document.querySelector('[aria-label="對話預覽"]')?.textContent?.includes('SESSIONBAY_SYNTHETIC_AG_ASSISTANT') === true,
    'Antigravity CLI persisted transcript did not reach the read-only UI preview');
    const preview = document.querySelector<HTMLElement>('[aria-label="對話預覽"]')!;
    if (!preview.textContent?.includes('sessionbay-smoke-antigravity') ||
      preview.textContent.includes('SESSIONBAY_SYNTHETIC_METADATA_NOT_TRANSCRIPT') ||
      Array.from(document.querySelectorAll('.session-card .agent-badge')).some((badge) => badge.textContent !== 'Antigravity CLI') ||
      document.querySelector('.workspace-tab, .xterm-host'))
      throw new Error('UI smoke: CLI filter must show only its real synthetic transcript without launching work');
  }
  // Allow the final committed layout to reach the compositor before capture.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  window.SessionBayStartup?.interaction();
}
