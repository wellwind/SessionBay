<div align="center">

<img src="src-tauri/icons/icon.png" width="96" alt="Session Bay icon">

# Session Bay

**Find your coding context. Continue your work.**

A local-first desktop workbench that brings the history of all your AI coding agents together, organized by project, with real terminals, split panes and a Git workbench built in.

[Website](https://fullstackladder.dev/SessionBay/) · [Download](https://github.com/wellwind/SessionBay/releases) · [Guide](https://fullstackladder.dev/SessionBay/guide/getting-started/) · [繁體中文](README.zh-TW.md)

</div>

![Session Bay showing sessions from several agents with a conversation preview](website/src/assets/screenshots/en/history.png)

## Why

One project rarely uses just one agent. Claude Code writes the code, Codex generates the assets, and when your quota runs out you switch to OpenCode with a free model. The context of that project ends up scattered across several agents, each keeping its own history in its own folder.

Session Bay indexes the local history of every supported agent, brings it together by project, and lets you search, preview and resume any session in the right folder with one click.

## Features

- **One history for every agent** — Claude Code, Codex CLI, OpenCode, Grok Build and Antigravity CLI. Full-text search (including CJK), filters by agent and date, and a read-only preview before you resume anything.
- **Project-first navigation** — pin the folders you care about; an "All directories" view still shows every place you ever ran an agent.
- **Real terminals** — tabs and split panes backed by real PTYs. Run agents, dev servers and tests side by side.
- **Keeps running when you close the window** — a background broker owns the processes; reopen Session Bay and reattach to the same running agents.
- **Attention notifications** — get a system notification when an agent is waiting for you, finishes or fails; click it to jump to that pane.
- **Git workbench** — diff with partial staging, commit, push/pull, history graph and blame, branches, stash, worktrees, three-way conflict resolution, and GitHub / self-hosted GitLab pull requests.
- **Drop files and images into agents**, preview workspace files and images, and open a temporary terminal without creating a project.
- **Safe cleanup** — sessions go to a recycle bin first; you can then move a session's files to the system trash after reviewing exactly what will move, and restore it later.
- **Themes and zoom** — dark and light themes, live preview, and one zoom level for the whole workbench.
- **English and Traditional Chinese** interface.

## Install

The first preview targets **macOS on Apple Silicon** (macOS 12 or later).

1. Download `Session.Bay_<version>_aarch64.dmg` from the [latest release](https://github.com/wellwind/SessionBay/releases).
2. Open the disk image and drag **Session Bay** into **Applications**.
3. The preview build is not notarized by Apple yet. The first time you open it, macOS will block it: open **System Settings → Privacy & Security** and click **Open Anyway**. See the [install guide](https://fullstackladder.dev/SessionBay/guide/install/) for screenshots.

Linux and Windows builds can be produced from source, but they have not been validated for release yet.

## Privacy and data safety

- Everything runs locally. Session Bay has no account, no server and no telemetry. It only checks GitHub Releases for new versions, which you can turn off.
- Agent history is **read-only**. The only exception is the explicit "Move to system trash" flow, which you confirm per session after reviewing every file.
- Agents still run with their own login, network access and permission settings.

Production stores its data under `dev.fullstackladder.sessionbay` (on macOS: `~/Library/Application Support/dev.fullstackladder.sessionbay`). The new identity starts fresh: earlier app data is not migrated, and macOS requires **Open Anyway** and notification permission again.

More detail: [Data safety](docs/data-safety.md).

## Build from source

Requirements: Node.js 24, Rust (pinned by `rust-toolchain.toml`) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm ci
npm run dev                 # run the desktop app
npm run tauri -- build      # build an unsigned bundle for this platform
```

`npm run dev` uses the separate **Session Bay Dev** profile (`dev.fullstackladder.sessionbay.dev`), imports production settings and curated projects on first launch, and disables update checks.

See [Development](docs/development.md) for tests and platform notes.

## Documentation

| | |
| --- | --- |
| [User guide](https://fullstackladder.dev/SessionBay/guide/getting-started/) | Install, find sessions, terminals, Git, cleanup |
| [Architecture](docs/architecture.md) | How the app, broker, indexer and runtime fit together |
| [Agent integrations](docs/agent-integrations.md) | Where each agent's history is read from and how resume works |
| [Data safety](docs/data-safety.md) | Read-only guarantees and the system trash flow |
| [Development](docs/development.md) | Building, testing and releasing |
| [Contributing](CONTRIBUTING.md) | How to propose changes |

## Status

Session Bay is in **early preview** (`0.x`). Expect rough edges, and please [open an issue](https://github.com/wellwind/SessionBay/issues) when something breaks.

## License

[MIT](LICENSE) © Mike Huang
