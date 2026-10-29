---
title: Settings
description: Agents and history sources, shell profiles, appearance, language and shortcuts.
sidebar:
  order: 8
---

Open **Settings** with the gear icon in the top bar.

![The settings dialog](../../../assets/screenshots/en/settings.png)

## Sources and tools

Each agent has its own card:

- **Enable** the agents you use. Disabled agents keep their indexed history but are not scanned or launched.
- **Executable path**: Session Bay looks in common install locations. Apps on macOS do not inherit your shell's `PATH`, so set an absolute path if an agent is not found.
- **Arguments and permissions**: extra launch arguments as a JSON array, for example `["--model", "your-model"]`. High-risk modes that skip permission prompts are off by default and must be enabled per agent.
- **History sources**: the folders history is read from. **Detect history sources** checks the official locations.

## Shell profiles

Choose which shell and arguments new terminals use, and add environment variables.

## Appearance and defaults

- **Language**: English, 繁體中文, or follow the system language. Changing it reloads the window; terminals reconnect.
- Interface and terminal themes, palettes, fonts and workbench zoom (<kbd>⌘</kbd><kbd>+</kbd> / <kbd>⌘</kbd><kbd>-</kbd> / <kbd>⌘</kbd><kbd>0</kbd>).
- The default agent and shell profile for **New work**, and system notifications.
- **Updates**: check GitHub Releases for new versions at startup and once a day. Updates are never installed automatically.

## Attention notifications and sounds

Under **Appearance and defaults**, the **System notifications** section has independent switches for OS notifications and **Play a sound when an agent needs attention**. Sounds are off by default, including for older configurations. Volume ranges from 0 to 100% (default 70%); 0 is silent.

Waiting plays an alert tone, completion a light tone, and failure a low tone. Tones use Web Audio synthesis with no bundled audio files. Alerts only trigger when the pane is off screen or the window is in the background, with a shared 5-second cooldown per pane. Sounds across panes are collected for 1.5 seconds, then one tone plays with priority **waiting > failure > completion**. OS notifications still arrive separately for each eligible pane. Enabling sounds requests `suppress-sound` on Linux to avoid duplicate audio, even at zero volume or when DND mutes the in-app tone. Windows toasts from Session Bay are already silent.

The three **Test** buttons use the unsaved volume, work even with sounds off, and bypass visibility gating and both cooldowns. They still respect detected Do Not Disturb (DND). Save settings to apply the sound switch and volume to agent events. If the WebView requires user activation, click or press a key in the app after enabling sounds; a test button also initializes audio.

### Do Not Disturb limitations

DND detection is best effort. If unavailable, unsuccessful, or unrecognized, sound plays as usual and only a debug log is written. OS notification policy remains controlled by the operating system.

- **macOS — unsupported, API choice UNVERIFIED:** `INFocusStatusCenter` was considered, but its entitlement, authorization and OS availability requirements were not verified. No Focus detector is enabled, so in-app sounds can play during Focus.
- **Windows — partial, API choice UNVERIFIED:** `SHQueryUserNotificationState` is queried for quiet time, presentation and busy/full-screen states. This is not verified coverage for Focus Assist or all modern DND modes; some modes may allow in-app sounds.
- **Linux — partial, API choices UNVERIFIED:** GNOME uses `gsettings` to read `org.gnome.desktop.notifications show-banners`; KDE uses `gdbus` to read the notification service's `Inhibited` property. The current desktop is selected from `XDG_CURRENT_DESKTOP`. Other desktops, missing tools/services, timeouts and unsupported properties fall back to playback. A banner setting or service inhibition is only a proxy for DND.

**Verification status:** the API choices above have not been checked against primary documentation or live OS behavior. Background/minimized playback has not been tested in macOS WKWebView, Windows WebView2 or Linux WebKitGTK. The implementation uses Web Audio; no Rust playback fallback has been introduced. Platform testing must establish reliability before deciding whether a Rust audio backend is needed.

## Keyboard shortcuts

Change the shortcuts for common commands. `Mod` means <kbd>⌘</kbd> on macOS.
