---
title: Terminals and split panes
description: Run agents, shells and dev servers side by side, and keep them running when the window closes.
sidebar:
  order: 4
---

![An agent and a dev server running side by side](../../../assets/screenshots/en/terminals.png)

## Start work

In a project, choose **New work** and pick:

- **Agent** to start a new agent conversation, or
- **Shell** for a regular terminal using your shell profile.

Before starting an agent, the dialog shows the exact command line and folder that will be used.

**Terminal** opens a shell straight away. **Temporary terminal** in the top bar opens a shell in your home folder without a project.

## Split and arrange

- Use the pane buttons to split **left and right** or **top and bottom**.
- Drag the divider to resize, or use the maximize button on a pane.
- Tabs can be reordered and renamed. <kbd>⌘</kbd><kbd>1</kbd>–<kbd>9</kbd> switch tabs.
- In a split, choose **Existing work** to move a pane from another tab, or resume a session right inside the split.

## Close the window, keep working

Terminals belong to a background process (the *broker*), not to the window. Closing Session Bay leaves your agents and dev servers running. When you reopen it, every pane reattaches to the same process with its recent output.

After an app update, Session Bay checks the background service's build. If it supports safe replacement and has no running agents, it updates automatically. Otherwise, a workspace notice shows how many agents are running. You can keep working; new agents still use the old service's launch logic until it is replaced. A service that supports safe replacement updates automatically after all its running agents end.

For an immediate update, choose **Restart background service**. The confirmation shows the number of running agents, including **0**, and warns that restarting ends every running agent, terminal and development server across all workspaces. They do not restart automatically. Older services (including those from 0.3.x before this feature) require this confirmed restart even when idle.

If the background service has died, reloading the window starts a new service. Interrupted agents stay interrupted until you start them again.

Terminals keep up to **10,000 lines of scrollback**. Reattaching restores the current screen and up to **1 MiB of the newest scrollback output**; older output may no longer be available.

- **Stop** ends a pane's process. Closing a pane asks before stopping it.
- After a restart of your Mac, panes show **interrupted**; start them again when you are ready.

## Files and images for agents

Drag files or images onto an agent pane, or paste them, to hand them to Claude Code, Codex, Grok Build or OpenCode. Paths are inserted but not sent, so you can add a request before pressing Enter.

## See everything at once

**All workspaces** in the sidebar shows every open pane across projects with its latest output. Agents that need you are listed first.

![The all-workspaces overview](../../../assets/screenshots/en/overview.png)
