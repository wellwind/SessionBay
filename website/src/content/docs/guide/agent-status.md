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

Status comes from the agents themselves (the Codex app server or the OSC 7501 terminal status sequence). Session Bay never guesses from the output text. If an agent cannot report status, its pane simply shows whether the process is running.

## System notifications

When an agent waits for input or permission, finishes or fails, Session Bay sends a system notification if its pane is off screen or the window is in the background. Click it to bring Session Bay forward on that pane. Each pane has a 5-second cooldown between alerts.

Turn notifications off in **Settings → Appearance and defaults → System notifications**. macOS may also ask for permission the first time.

You can enable an **optional attention sound** separately; it is off by default. Volume and test buttons are in the same section. See [sound settings and Do Not Disturb limitations](/SessionBay/guide/settings/#attention-notifications-and-sounds).

## Live status

Enable **live status** for each agent in **Settings → Sources and tools**. The existing per-agent setting is preserved. It applies to launches from Session Bay and never changes your global agent settings. Claude Code needs **2.1.295 or later**; OpenCode needs reviewed **2.2.0–2.2.5**. Unsupported status versions still launch with process state only and a clear panel notice. OpenCode CLI 1.x is no longer supported.

Claude Code and OpenCode now use OSC 7501 terminal reports. A working-to-idle transition in the same runtime raises one completion alert; an initial idle when opening or reattaching a pane stays quiet. Explicit done/error reports retain their existing behavior. OpenCode can report permission and question waits, but **cannot report failures** through its current OSC sequence. These alerts use the same visibility rules and cooldown as other attention notifications and sounds.

Claude keeps only a SessionStart hook to identify its native session. OpenCode needs no Session Bay plugin or injected configuration; its terminal record IDs are accepted as session identity only after the history catalog confirms a 2.x session with matching directory and creation time after launch. Until then, automatic board attachment may wait for indexing. Terminal status is display-only and never authorizes an action.

Claude Code 2.1.316's startup capability query and exit clear were verified offline; its normal working/waiting/completion/error reports still need verification in a real session. OpenCode's OSC states were verified in 2.2.3 source; a real end-to-end model run remains unverified.
