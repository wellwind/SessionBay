import { call } from './api';
import { agentKinds, agentNames } from './agents';
import { smokeSnapshot } from './startup';
import { t } from './i18n';

/** Invoked only after the native diagnostic command confirms SESSIONBAY_SMOKE=1. */
export async function runSmokeInteraction(): Promise<void> {
  // Bundled fonts must load under the production CSP in every native webview
  // (all three expose FontFaceSet; jsdom unit tests do not).
  if (document.fonts) for (const [face, sample] of [["14px 'Inter Variable'", 'Aa'], ["14px 'JetBrains Mono Variable'", 'Aa'], ["14px 'Noto Sans TC Variable'", '工作']]) {
    const loaded = await document.fonts.load(face, sample).catch(() => []);
    if (!loaded.length) throw new Error(`UI smoke: bundled font did not load (${face})`);
  }
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
    if (!button || button.matches(':disabled, [aria-disabled="true"]') || button.getBoundingClientRect().width <= 0) {
      const name = button?.getAttribute('aria-label') ?? button?.textContent?.trim() ?? '';
      const reason = !button ? 'missing' : button.getBoundingClientRect().width <= 0 ? 'zero width' : 'disabled';
      throw new Error(`UI smoke: expected a visible, enabled control (${reason}${name ? `: ${name}` : ''})`);
    }
    if (button.getAttribute('role') !== 'option') button.focus({ preventScroll: true });
    button.click();
  };
  const selectAgent = async (kind: (typeof agentKinds)[number]) => {
    const name = agentNames[kind];
    const picker = dialog()?.querySelector<HTMLInputElement>(`[role="combobox"][aria-label="${t('Search agents')}"]`);
    click(picker ?? null);
    await waitFor(() => !!dialog()?.querySelector('[role="listbox"]'), 'tool dropdown did not open');
    if (dialog()!.querySelectorAll('[role="option"]').length !== agentKinds.length)
      throw new Error('UI smoke: expected all providers in the dropdown');
    click(dialog()?.querySelector<HTMLElement>(`[role="option"][data-value="${kind}"]`) ?? null);
    await waitFor(() => picker?.value === name && picker.getAttribute('aria-expanded') === 'false' &&
      !!dialog()?.querySelector(`[aria-label="${t('{{agent}} history sources', { agent: name })}"]`), `${name} settings did not open`);
    if (dialog()!.querySelectorAll('.settings-history-provider').length !== 1 ||
      dialog()!.querySelectorAll('.settings-installation').length !== 1)
      throw new Error(`UI smoke: expected only selected ${name} configuration`);
  };
  const close = () =>
    click(dialog()?.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('Set up later')}"], button[aria-label="${t('Close settings')}"]`,
    ) ?? null);
  const open = () => click(document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('Settings and sources')}"]`,
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
    const checkbox = dialog()?.querySelector<HTMLInputElement>(`input[aria-label="${t('{{agent}} skip permission prompts', { agent: name })}"]`);
    if (!checkbox || checkbox.checked) throw new Error(`UI smoke: missing/default-unsafe ${name} options`);
  }
  close();
  await waitFor(() => !dialog(), 'settings dialog did not dismiss before project navigation');
  const projectDialog = () => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${t('Add or create a project')}"]`);
  const openProject = () => click(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('Add project')}"]`));
  const projectButton = (label: string) => Array.from(projectDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((button) => button.textContent?.trim() === label) ?? null;
  if (document.querySelector('h1')?.textContent !== t('Projects'))
    throw new Error('UI smoke: curated Projects is not the default navigation page');
  if (document.querySelector(`nav[aria-label="${t('Projects')}"] .project-row`))
    throw new Error('UI smoke: blank HOME unexpectedly contains curated projects');
  click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
  await waitFor(() => document.querySelector('h1')?.textContent === t('All directories'), 'directory navigation page did not open');
  if (!document.querySelector(`[aria-label="${t('All directories overview')}"]`) || document.querySelector('#session-search'))
    throw new Error('UI smoke: directory overview was replaced by a mixed-session list');
  click(document.querySelector<HTMLButtonElement>('#navigation-projects'));
  await waitFor(() => document.querySelector('h1')?.textContent === t('Projects'), 'project management page did not reopen');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not open');
  click(projectButton(t('Create new project')));
  await waitFor(() => !!projectButton(t('Create and add')), 'create project mode did not open');
  click(projectButton(t('Cancel')));
  await waitFor(() => !projectDialog(), 'project dialog did not cancel');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not reopen');
  // Form state must reset after cancel, and no create/add command is submitted.
  await waitFor(() => projectButton(t('Add existing folder'))?.classList.contains('selected') === true,
    'cancelled project creation leaked into the next dialog');
  click(projectButton(t('Create new project')));
  await waitFor(() => !!projectButton(t('Create and add')), 'create project mode did not reopen');
  if (fixtureRoot) {
    click(projectButton(t('Cancel')));
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
      await waitFor(() => projectButton(t('Add project'))?.disabled === false, 'fixture project submit did not enable');
      click(projectButton(t('Add project')));
      await waitFor(() => !projectDialog(), 'fixture project could not be added');
    }
    click(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('Update index')}"]`));
    click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
    await waitFor(() => document.querySelectorAll(`[aria-label="${t('All directories overview')}"] button[aria-label^="${t('Browse directory {{name}}', { name: '' })}"]`).length >= 4,
      'synthetic histories were not indexed into four directory groups');
    const theme = document.documentElement.dataset.theme;
    if (theme !== 'dark' && theme !== 'light') throw new Error('UI smoke: fixture theme must be explicit');
    click(document.querySelector<HTMLButtonElement>('#navigation-projects'));
    await waitFor(() => document.querySelector('h1')?.textContent === t('Projects'), 'fixture projects overview did not open');
    await smokeSnapshot(`projects-${theme}`);
    click(document.querySelector<HTMLButtonElement>('#navigation-directories'));
    await waitFor(() => document.querySelector('h1')?.textContent === t('All directories'), 'fixture directory overview did not open');
    if (!document.querySelector(`[aria-label="${t('All directories overview')}"]`)?.textContent?.includes(t('Unclassified · no working directory recorded')))
      throw new Error('UI smoke: unknown directory group is missing');
    await smokeSnapshot(`directories-${theme}`);
    open();
    await waitFor(() => !!dialog(), 'provider settings did not open');
    for (const kind of agentKinds) await selectAgent(kind);
    await selectAgent('codex');
    dialog()!.querySelector('.settings-agent-picker')?.scrollIntoView({ block: 'start' });
    await smokeSnapshot(`providers-${theme}`);
    // Exercise the native read-only discovery IPC against CI's isolated, empty GROK_HOME.
    // Merely finding a candidate must not add a draft source or launch a runtime.
    const sourceRoots = async () => {
      const name = dialog()!.querySelector<HTMLInputElement>(`[role="combobox"][aria-label="${t('Search agents')}"]`)!.value;
      const selected = agentKinds.find((kind) => agentNames[kind] === name)!;
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
    click(dialog()!.querySelector<HTMLButtonElement>(`button[aria-label="${t('Detect {{agent}} history sources', { agent: 'Grok Build' })}"]`));
    const grokHistory = () => dialog()?.querySelector<HTMLElement>(`[aria-label="${t('{{agent}} history sources', { agent: 'Grok Build' })}"]`);
    await waitFor(() => !!grokHistory()?.querySelector('.settings-source-candidate') &&
      !grokHistory()?.querySelector<HTMLButtonElement>(`button[aria-label="${t('Detect {{agent}} history sources', { agent: 'Grok Build' })}"]`)?.matches(':disabled'),
    'Grok history discovery did not resolve');
    const readableGrokCandidate = Array.from(grokHistory()!.querySelectorAll<HTMLElement>('.settings-source-candidate'))
      .find((candidate) => candidate.querySelector('.settings-status')?.textContent === t('Readable folder found'));
    if (!readableGrokCandidate?.querySelector<HTMLButtonElement>(`button[aria-label^="${t('Add detected {{agent}} source {{root}}', { agent: 'Grok Build', root: '' })}"]`) ||
      readableGrokCandidate.querySelector<HTMLButtonElement>('button')?.disabled ||
      JSON.stringify(await sourceRoots()) !== JSON.stringify(rootsBeforeDetection) ||
      grokHistory()!.querySelector('.settings-source') || document.querySelector('.workspace-tab, .xterm-host'))
      throw new Error('UI smoke: history discovery must offer the empty Grok root without adding a source or launching work');
    close();
    await waitFor(() => !dialog(), 'provider settings did not close');
    click(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('Browse directory {{name}}', { name: 'Harbor Console' })}"]`));
    await waitFor(() => (document.querySelector<HTMLButtonElement>(`.workspace-activity[aria-label="${t('History sessions')}"]`)?.getBoundingClientRect().width ?? 0) > 0,
      'fixture project tools did not open');
    const sessionsActivity = document.querySelector<HTMLButtonElement>(`.workspace-activity[aria-label="${t('History sessions')}"]`);
    if (sessionsActivity?.getAttribute('aria-pressed') !== 'true') click(sessionsActivity);
    await waitFor(() => !!document.querySelector('#session-search'), 'fixture scoped history did not open');
    const buttonByText = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === label) ?? null;
    // Short windows (<=640px inner height) collapse secondary chrome into a menu.
    const revealed = async (button: HTMLButtonElement | null) => {
      const hidden = button?.closest<HTMLElement>('.responsive-control-content[hidden]');
      if (hidden) {
        click(hidden.parentElement?.querySelector<HTMLButtonElement>(':scope > .compact-control-heading > button') ?? null);
        await waitFor(() => !hidden.hidden, 'compact controls did not open');
      }
      return button;
    };
    // Open only: never submit the new-work launcher or start a shell/Agent process.
    click(await revealed(buttonByText(t('New work'))));
    const launcher = () => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${t('Start a new task')}"]`);
    await waitFor(() => !!launcher(), 'fixture launcher did not open');
    click(Array.from(launcher()!.querySelectorAll<HTMLButtonElement>(`[aria-label="${t('Work type')}"] button`))
      .find((button) => button.textContent?.startsWith('Shell')) ?? null);
    await waitFor(() => !!launcher()?.querySelector(`[aria-label="${t('Launch arguments preview')}"] pre`),
      'fixture shell preview did not resolve');
    click(Array.from(launcher()!.querySelectorAll<HTMLButtonElement>(`[aria-label="${t('Work type')}"] button`))
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
    click(await revealed(buttonByText(t('Filter'))));
    await waitFor(() => !!document.querySelector(`button[aria-label="${t('{{label}}, open calendar', { label: t('Start date') })}"]`), 'history date filter did not appear');
    // Pick a stable month for deterministic screenshots without filtering the fixture history.
    const dateInput = document.querySelector<HTMLInputElement>(`input[aria-label="${t('Start date')}"]`);
    dateInput?.focus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    setInput(dateInput, '2026-01-01');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    dateInput?.blur();
    click(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('{{label}}, open calendar', { label: t('Start date') })}"]`));
    await waitFor(() => !!document.querySelector(`[role="dialog"][aria-label="${t('Choose {{label}}', { label: t('Start date') })}"] [role="grid"]`),
      'history calendar did not open');
    await smokeSnapshot(`calendar-${theme}`);
    document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${t('Choose {{label}}', { label: t('Start date') })}"]`)!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector(`[role="dialog"][aria-label="${t('Choose {{label}}', { label: t('Start date') })}"]`),
      'fixture calendar did not dismiss');
    // Keep the five screenshot states stable; verify the new CLI reader through
    // the real UI and IPC only after the final snapshot has been captured.
    open();
    await waitFor(() => !!dialog(), 'settings did not reopen for CLI history discovery');
    await selectAgent('antigravity');
    const antigravityRootsBefore = await sourceRoots();
    click(dialog()!.querySelector<HTMLButtonElement>(`button[aria-label="${t('Detect {{agent}} history sources', { agent: 'Antigravity CLI' })}"]`));
    const antigravityHistory = () => dialog()?.querySelector<HTMLElement>(`[aria-label="${t('{{agent}} history sources', { agent: 'Antigravity CLI' })}"]`);
    await waitFor(() => !!antigravityHistory()?.querySelector('.settings-source-candidate') &&
      !antigravityHistory()?.querySelector<HTMLButtonElement>(`button[aria-label="${t('Detect {{agent}} history sources', { agent: 'Antigravity CLI' })}"]`)?.matches(':disabled'),
    'Antigravity CLI history discovery did not resolve');
    const nativeCandidate = Array.from(antigravityHistory()!.querySelectorAll<HTMLElement>('.settings-source-candidate'))
      .find((candidate) => candidate.querySelector('code')?.textContent?.endsWith('/.gemini/antigravity-cli'));
    if (nativeCandidate?.querySelector('.settings-status')?.textContent !== t('Readable folder found') ||
      !nativeCandidate.querySelector<HTMLButtonElement>(`button[aria-label^="${t('Add detected {{agent}} source {{root}}', { agent: 'Antigravity CLI', root: '' })}"]`)?.disabled ||
      JSON.stringify(await sourceRoots()) !== JSON.stringify(antigravityRootsBefore))
      throw new Error('UI smoke: native CLI discovery must recognize its configured synthetic root without mutating sources');
    close();
    await waitFor(() => !dialog(), 'CLI discovery settings did not close without saving');
    click(document.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${t('Filter by agent')}"]`));
    await waitFor(() => !!document.querySelector(`[role="listbox"][aria-label="${t('Filter by agent')}"]`),
      'history Agent filter did not open');
    click(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.querySelector('.select-option-copy > span')?.textContent === 'Antigravity CLI') ?? null);
    // The newest native fixture is already Antigravity, so its preview can be
    // present before filtering. Wait for the asynchronous list commit as well.
    await waitFor(() => {
      const list = document.querySelector(`[aria-label="${t('Session list')}"]`);
      const badges = Array.from(list?.querySelectorAll('.session-card .agent-badge') ?? []);
      return list?.getAttribute('aria-busy') === 'false' && badges.length > 0 &&
        badges.every((badge) => badge.textContent === 'Antigravity CLI');
    }, 'Antigravity CLI filter did not commit a nonempty CLI-only session list');
    await waitFor(() => document.querySelector(`[aria-label="${t('Conversation preview')}"]`)?.textContent?.includes('SESSIONBAY_SYNTHETIC_AG_USER') === true &&
      document.querySelector(`[aria-label="${t('Conversation preview')}"]`)?.textContent?.includes('SESSIONBAY_SYNTHETIC_AG_ASSISTANT') === true,
    'Antigravity CLI persisted transcript did not reach the read-only UI preview');
    const preview = document.querySelector<HTMLElement>(`[aria-label="${t('Conversation preview')}"]`)!;
    if (!preview.textContent?.includes('sessionbay-smoke-antigravity') ||
      preview.textContent.includes('SESSIONBAY_SYNTHETIC_METADATA_NOT_TRANSCRIPT') ||
      Array.from(document.querySelectorAll('.session-card .agent-badge')).some((badge) => badge.textContent !== 'Antigravity CLI') ||
      document.querySelector('.workspace-tab, .xterm-host'))
      throw new Error('UI smoke: CLI filter must show only its real synthetic transcript without launching work');
  }
  if (await call<boolean>('frontend_diagnostic', { phase: 'terminal-probe', message: 'enabled' })) {
    if (projectDialog()) {
      click(projectButton(t('Cancel')));
      await waitFor(() => !projectDialog(), 'project dialog did not dismiss before terminal smoke');
    }
    const { runTerminalSmoke } = await import('./terminal-smoke');
    await runTerminalSmoke();
  }
  if (await call<boolean>('frontend_diagnostic', { phase: 'files-probe', message: 'enabled' })) {
    if (projectDialog()) {
      click(projectButton(t('Cancel')));
      await waitFor(() => !projectDialog(), 'project dialog did not dismiss before files smoke');
    }
    const { runFilesSmoke } = await import('./files-smoke');
    await runFilesSmoke();
  }
  if (await call<boolean>('frontend_diagnostic', { phase: 'git-probe', message: 'enabled' })) {
    if (projectDialog()) {
      click(projectButton(t('Cancel')));
      await waitFor(() => !projectDialog(), 'project dialog did not dismiss before Git smoke');
    }
    const { runGitSmoke } = await import('./git-smoke');
    await runGitSmoke();
  }
  if (await call<boolean>('frontend_diagnostic', { phase: 'monaco-probe', message: 'enabled' })) {
    const { runMonacoSmoke } = await import('./monaco-smoke');
    await runMonacoSmoke();
    if (fixtureRoot) {
      const { runLargeFileSmoke } = await import('./large-file-smoke');
      await runLargeFileSmoke(fixtureRoot);
      const { runFileImageSmoke } = await import('./file-image-smoke');
      await runFileImageSmoke(fixtureRoot);
    }
  }
  // Allow the final committed layout to reach the compositor before capture.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  window.SessionBayStartup?.interaction();
}
