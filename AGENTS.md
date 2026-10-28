# Repository guidelines

Session Bay is a local-first desktop workbench for AI coding agents: unified session history, real terminals and a Git workbench. Tauri 2 + Rust core, React/TypeScript UI.

## Layout

- `src/`: React/TypeScript UI. `src/i18n.ts` and `src/locales/` hold translations; `src-tauri/src/i18n.rs` reads the same catalog.
- `src-tauri/src/`: Rust catalog, adapters, config, service, broker/runtime, Git and Tauri IPC (`desktop.rs`).
- `src-tauri/tests/`, `src/*.test.ts(x)`, `tests/browser/`: tests. `fixtures/` holds synthetic data only.
- `docs/`: developer docs (architecture, agent integrations, data safety, development).
- `website/`: the GitHub Pages site and user guide (Astro Starlight, English and Traditional Chinese).

## Commands

- `npm ci`, then `npm run dev` to run the desktop app.
- `npm run typecheck && npm run lint && npm test && npm run build`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --no-default-features --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` runs the full crate with the desktop feature.

## Style

- Docs, code comments, commit messages and PR descriptions are in English. The user guide and README also have a Traditional Chinese version (`README.zh-TW.md`, `website/src/content/docs/zh-tw/`); keep both in sync.
- Write user-facing text in English and wrap it: `t('…')` in TypeScript, `tr!("…")` in Rust. Add the Traditional Chinese translation to `src/locales/zh-TW.json`; `src/locales/en.json` only holds English plural forms (`<key>_one`). `src/i18n.test.ts` fails when a translation is missing. Most UI tests run in zh-TW.
- Rust uses rustfmt and Clippy. TypeScript uses ESLint and strict mode, with two-space indentation.
- Keep comments concise and focused on intent or non-obvious constraints.
- Separate verified results from unverified assumptions in PRs and docs. Never claim a platform works without testing on it.

## Commits and pull requests

- Work on a feature branch; never commit to `main` directly.
- Use short, specific commit messages such as `docs: clarify resume behavior`, with one focused change per commit.
- PRs describe the purpose, how it was tested and what remains unverified. Attach screenshots for UI changes.
- Merge only after CI is green.

## Data safety

- Agent history is read-only. The only exception is the per-session, user-confirmed move to the system trash ([docs/data-safety.md](docs/data-safety.md)). Tests must use synthetic data and fake movers.
- Never commit credentials, real conversations or local indexes.
- Launch processes with the executable, args and cwd passed separately. Never build shell commands from untrusted text.

## UI/UX skill

For UI structure, visual design, interaction, responsive layout or accessibility work, read [UI UX Pro Max](.agents/skills/ui-ux-pro-max/SKILL.md) first and search the domain or stack that fits the task. Its suggestions do not override the existing UI. Backend-only work does not need it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for wellwind/SessionBay (gh CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
