---
title: Recycle bin and cleanup
description: Hide sessions, restore them, or move their files to the system trash.
sidebar:
  order: 7
---

Deleting a session is a two-step process, so you never lose history by accident.

## 1. Recycle bin

Choose the trash icon on a session. It moves to Session Bay's **recycle bin** and disappears from history and search. The agent's files are not touched. **Undo delete** brings it back immediately, or open the recycle bin from the trash icon at the top of a project later.

Recycled sessions are also hidden from [board tasks](/SessionBay/guide/kanban/). Restoring a session shows it on its task again. Archiving or deleting a board task is separate from deleting its sessions.

## 2. Move to the system trash

To really free the files, choose **Move to system trash…**, either in the delete dialog or on an entry in the recycle bin. Session Bay shows:

- every file and folder of that session that will move;
- shared storage that stays untouched;
- anything that blocks the move, for example a session that is still running.

Check the box to confirm and choose **Move to system trash**. Session Bay re-checks every file right before moving it.

OpenCode keeps sessions in a shared database, so Session Bay exports the session with the official `opencode` CLI first and then deletes it through the CLI.

## Restore

The recycle bin's **Moved to system trash** section lists what you moved. **Restore** puts the files back in their original location, as long as the system trash has not been emptied. Emptying the trash deletes them for good.
