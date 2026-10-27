---
title: FAQ
description: Common questions and fixes.
---

### macOS says the app cannot be opened

The preview is not notarized yet. Use **System Settings → Privacy & Security → Open Anyway**; see [Install](/SessionBay/guide/install/#open-it-the-first-time).

### An agent is "not found"

Apps on macOS do not see your shell's `PATH`. Set the absolute path in **Settings → Sources and tools → Executable path**, for example the output of `which claude`.

### My history is empty

Check **Settings → Sources and tools → History sources** for that agent. Choose **Detect history sources**, save, and let the scan finish. Only sessions written by the agent's CLI are supported.

### A project moved to another folder

Choose **Relocate** next to the project path. New processes start in the new location; the original history is not rewritten.

### Does closing Session Bay stop my agents?

No. Agents and terminals keep running in the background and reattach when you reopen Session Bay. Use **Stop** on a pane to end it.

### Can I use Session Bay in Chinese?

Yes. **Settings → Appearance and defaults → Language**.

### Where do I report a bug?

[Open an issue](https://github.com/wellwind/SessionBay/issues/new/choose). Please do not paste real conversations or tokens.
