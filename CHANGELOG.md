# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Claude Code sessions launched with activity hooks now raise waiting and done notifications and sounds; before, only failures did. Provider busy-to-idle transitions also raise done alerts for OpenCode, while initial idle reports stay quiet.

## [0.3.1] - 2026-10-30

### Added

- A board panel in the right activity bar shows the project's tasks next to the terminals, with a needs-attention badge on its icon. Toggle it with **Mod+Shift+K**.

### Changed

- Boards are drag-first: whole cards drag between columns, the per-card **Move to…** menu is gone, and the stage selector in task details is the non-drag alternative. Alt+arrow keyboard moves still work.
- The full board opens from the board panel or the **Open full board** command, with no tab-bar entry; task details open in a side drawer.
- Board toolbar and cards are redesigned: Unsorted is shown as an inbox strip, columns have inline quick add, moves and archives can be undone, and All boards can group by project.

### Fixed

- A focused control no longer loses focus when a resize removes the compact pane menu.

## [0.3.0] - 2026-10-29

### Added

- **Kanban boards** for curated projects ([guide](https://fullstackladder.dev/SessionBay/guide/kanban/)):
  - boards are enabled per project, with configurable columns and stages;
  - each card is a task that can hold several agent sessions; new and resumed sessions land in **Unsorted**;
  - cards move by drag, keyboard or a **Move to…** menu, and show live agent status and branch;
  - task details: notes, start or resume work (task text is pasted into the agent but never sent), merge and split, and binding a task to a worktree;
  - Done tasks can be archived, deleted, or have their sessions sent to the recycle bin; optional auto-archive;
  - **All boards** shows every enabled board by stage, filtered by project, text, agent or needs attention.

  Board data lives in Session Bay's catalog and never touches agent history.
- An optional sound when an agent needs attention, with a volume setting and a test button for each event. It is off by default.

### Changed

- Terminals keep 10,000 lines of scrollback, and a reattached terminal restores up to 1 MiB of the newest output. Before, reattaching restored about 200 lines.
- The local catalog is upgraded to schema v8 to store boards. After the upgrade, 0.2.0 can no longer open it.

### Fixed

- Claude Code sessions show the title Claude Code generates instead of the first prompt or raw harness tags, and current sessions are no longer marked "Partially parsed".
- Claude Code status reporting resumes at the next turn after a single lost report, instead of staying unknown for the rest of the session.
- Terminals started by Session Bay no longer inherit the launcher's `nvm` and `npm` session state, which could hide `node`, `npm` and npm-installed CLIs.
- Dialogs keep keyboard focus inside them when they contain a collapsed section.

## [0.2.0] - 2026-10-29

### Changed

- Production now uses the app identity `dev.fullstackladder.sessionbay`. Data from the previous identity does not carry over. On macOS, use **Open Anyway** again on first launch and grant notification permission again.
- `npm run dev` opens **Session Bay Dev**, with a separate data folder and broker, an orange DEV icon and top-bar tag, and no update checks. Its first launch imports production settings and curated projects; Settings can repeat the import after confirmation. Indexes, layouts, recycle bins and Git host tokens stay separate.

### Fixed

- The search box in the split dialog's **Existing work** tab drew two focus rings.
- When the app was opened from Finder or the Dock, agent CLIs installed through nvm, fnm, volta, mise, asdf or bun were reported as missing.
- The unread-output dot on a workspace tab with no known agent status now sits on the tab's icon instead of floating over the title.

## [0.1.0] - 2026-10-28

First public preview. macOS on Apple Silicon only.

### Added

- **History**:
  - unified, read-only history for Claude Code, Codex CLI, OpenCode, Grok Build and Antigravity CLI;
  - full-text search (including CJK);
  - preview, and resume in the original directory.
- **Projects**: a curated project list plus an "All directories" view.
- **Terminals**:
  - tabs and split panes backed by real PTYs;
  - processes survive closing the window and reattach on reopen;
  - temporary home terminal;
  - multi-workspace overview.
- **Agent awareness**:
  - status badges;
  - system notifications that jump to the pane when clicked.
- **Git workbench**:
  - diff with partial staging, commit, push/pull;
  - history graph and blame, branches, stash, worktrees;
  - three-way conflict resolution;
  - GitHub and GitLab pull requests.
- **Files**:
  - drag and drop or paste files and images into agents;
  - read-only workspace file and image preview.
- **Cleanup**: a recycle bin, then a reviewed move to the system trash with restore.
- **Update notice**: checks GitHub Releases at startup and daily and shows a notice when a new version is out (can be turned off).
- **Interface**:
  - themes with live preview, and zoom for the whole workbench;
  - English and Traditional Chinese.

### Known limitations

- The macOS build is not notarized; use **Open Anyway** the first time.
- Linux and Windows builds are not validated for release.
- Updates are not installed in the app; the update notice links to the release page.

[Unreleased]: https://github.com/wellwind/SessionBay/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/wellwind/SessionBay/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wellwind/SessionBay/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/wellwind/SessionBay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wellwind/SessionBay/releases/tag/v0.1.0
