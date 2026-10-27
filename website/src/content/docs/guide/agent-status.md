---
title: Agent status and notifications
description: Know when an agent is working, waiting for you, finished or failed.
sidebar:
  order: 5
---

Session Bay shows what each agent is doing next to its tab, in the sidebar and in **All workspaces**:

| Status | Meaning |
| --- | --- |
| Working | The agent is running a step. |
| Waiting for input / permission | The agent needs an answer from you. |
| Done | The agent finished its turn. |
| Failed | The agent reported an error. |

Status comes from the agents themselves (activity hooks, the Codex app server, or the terminal status sequence). Session Bay never guesses from the output text. If an agent cannot report status, its pane simply shows whether the process is running.

## System notifications

When an agent needs attention and its pane is not on screen, Session Bay sends a macOS notification. Click it to bring Session Bay forward on that pane.

Turn notifications off in **Settings → Appearance and defaults → System notifications**. macOS may also ask for permission the first time.

## Activity hooks

For live status from Claude Code and OpenCode, enable **activity hooks** for that agent in **Settings → Sources and tools**. They only apply to agents started from Session Bay and never change your global agent settings.
