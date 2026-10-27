---
title: Install
description: Install Session Bay on macOS, and what to do the first time macOS blocks it.
sidebar:
  order: 2
---

The first preview supports **macOS 12 or later on Apple Silicon** (M1 or newer).

## Download

1. Open the [latest release](https://github.com/wellwind/SessionBay/releases/latest).
2. Download `Session.Bay_<version>_aarch64.dmg`. You can check the download with the `.sha256` file next to it:

   ```bash
   shasum -a 256 ~/Downloads/Session.Bay_*_aarch64.dmg
   ```

3. Open the disk image and drag **Session Bay** into **Applications**.

## Open it the first time

The preview is not notarized by Apple yet, so macOS blocks the first launch:

1. Open **Session Bay** from Applications. macOS says it cannot verify the app. Choose **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Next to *"Session Bay" was blocked*, choose **Open Anyway** and confirm with your password or Touch ID.

You only do this once. Later versions can be opened normally after you install them the same way.

:::note
Session Bay never asks you to turn off Gatekeeper or System Integrity Protection. If a download looks wrong, delete it and get it again from the release page.
:::

## Install your agents

Session Bay launches the agent CLIs you already use; it does not bundle them. Install and sign in to each agent first, following its own documentation. If an agent is missing, Session Bay still shows its existing history.

## Update or uninstall

- **Update**: Session Bay shows a notice in the bottom-left corner when a new version is on GitHub. Choose **View release**, download the new version and replace the app in Applications. Running agents keep going while you update; close Session Bay first.
- **Uninstall**: delete the app. Session Bay's own data (index, settings, layout) is in `~/Library/Application Support/dev.sessionbay.desktop`; delete that folder too if you want. Your agents' history is never touched.

## Linux and Windows

They can be built from source but are not validated for release yet. See [Build from source](https://github.com/wellwind/SessionBay#build-from-source).
