# Security policy

## Supported versions

Only the latest release receives security fixes while Session Bay is in `0.x`.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately through [GitHub security advisories](https://github.com/wellwind/SessionBay/security/advisories/new).

Include:

- the version and OS;
- what an attacker can do;
- steps to reproduce.

Use synthetic data in your report, never real conversations or credentials.

You can expect an acknowledgement within a week. Please allow time for a fix before you disclose the issue publicly.

## Scope

Session Bay runs locally and launches agent CLIs that you have installed yourself. The following are especially in scope:

- anything that writes to or leaks agent history;
- escaping the confirmed "move to trash" flow;
- command injection through session data, paths or settings;
- access to the broker socket by other users.
