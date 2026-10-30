---
title: Agent status and notifications
description: Know when an agent is working, waiting for you, finished or failed.
sidebar:
  order: 5
---

Session Bay shows what each agent is doing next to its tab, in the sidebar, in **All workspaces** and on attached [board tasks](/SessionBay/guide/kanban/):

| Status | Meaning |
| --- | --- |
| Working | The agent is running a step. |
| Waiting for input / permission | The agent needs an answer from you. |
| Done | The agent finished its turn. |
| Failed | The agent reported an error. |

Status comes from the agents themselves (activity hooks, the Codex app server, or the terminal status sequence). Session Bay never guesses from the output text. If an agent cannot report status, its pane simply shows whether the process is running.

## System notifications

When an agent waits for input or permission, finishes or fails, Session Bay sends a system notification if its pane is off screen or the window is in the background. Click it to bring Session Bay forward on that pane. Each pane has a 5-second cooldown between alerts.

Turn notifications off in **Settings → Appearance and defaults → System notifications**. macOS may also ask for permission the first time.

You can enable an **optional attention sound** separately; it is off by default. Volume and test buttons are in the same section. See [sound settings and Do Not Disturb limitations](/SessionBay/guide/settings/#attention-notifications-and-sounds).

## Activity hooks

For live status from Claude Code and OpenCode, enable **activity hooks** for that agent in **Settings → Sources and tools**. They only apply to agents started from Session Bay and never change your global agent settings.

Claude Code reports waiting for input or permission through launch-local command hooks alongside its live state plugin. For Claude Code and OpenCode, a working-to-idle transition raises a completion alert; an initial idle report when opening or reattaching a pane does not. These alerts use the same visibility rules and cooldown as other attention notifications and sounds.

If a Claude Code status report is lost, status may be unknown until the next main turn, when reporting resumes.
