---
title: Privacy and data
description: What Session Bay reads, what it stores and what never leaves your machine.
---

- **No account, no server, no telemetry.** Indexing, search and preview happen entirely on your Mac.
- **Agent history is read-only.** The only exception is [moving a session to the system trash](/SessionBay/guide/cleanup/), which you confirm per session.
- **Session Bay's own data** lives in `~/Library/Application Support/dev.fullstackladder.sessionbay`: the search index, settings and window layout. The index contains conversation text, so treat the folder as private. It is readable only by your user.
- **Agents run as usual.** Agents you launch use the network, files and permissions according to their own settings.
- **Tokens for GitHub or GitLab** are kept in your system credential store, never in Session Bay's settings or logs.
- **Network use by Session Bay itself** is limited to:
  - the GitHub or GitLab hosts you add for pull requests;
  - an anonymous request to the public GitHub Releases list at startup and once a day, to tell you about new versions. Turn it off in **Settings → Appearance and defaults → Updates**.

The source code is [on GitHub](https://github.com/wellwind/SessionBay); the developer documentation describes the [data safety rules](https://github.com/wellwind/SessionBay/blob/main/docs/data-safety.md) in detail.

Development builds use `dev.fullstackladder.sessionbay.dev` and a separate broker. On first launch, dev imports saved production settings and curated projects; Settings can repeat this after confirmation. Production is read-only. Indexes, layouts, recycle bins and Git host tokens are not imported, and dev update checks are disabled.
