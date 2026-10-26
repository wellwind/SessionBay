# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Unreleased

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
- **Interface**:
  - themes with live preview, and zoom for the whole workbench;
  - English and Traditional Chinese.

### Known limitations

- The macOS build is not notarized; use **Open Anyway** the first time.
- Linux and Windows builds are not validated for release.
- There are no in-app updates yet; download new versions from GitHub Releases.

[Unreleased]: https://github.com/wellwind/SessionBay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wellwind/SessionBay/releases/tag/v0.1.0
