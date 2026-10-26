# Repository guidelines

Session Bay is a local-first desktop workbench for AI coding agents: unified session history, real terminals and a Git workbench. Tauri 2 + Rust core, React/TypeScript UI.

## Layout

- `src/`: React/TypeScript UI. `src/locales/` holds the `en` and `zh-TW` strings.
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
- Every user-facing UI string goes through i18n and must exist in both `en` and `zh-TW`.
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
