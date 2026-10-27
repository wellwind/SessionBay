# Contributing to Session Bay

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

- Search [existing issues](https://github.com/wellwind/SessionBay/issues) first.
- For bugs, include your OS and version, the Session Bay version, the agent and its version, and steps to reproduce.
- **Never paste real conversations, tokens or private paths.** Redact them or reproduce with a throwaway session.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

1. Fork the repo and create a feature branch from `main`.
2. Follow [Development](docs/development.md) to run the app and the checks.
3. Keep each PR focused on one change. Describe what it does, how you tested it, and anything still unverified.
4. Attach screenshots for UI changes.
5. Make sure CI is green.

### Ground rules

- **Agent history stays read-only.** The only exception is the reviewed "move to system trash" flow ([Data safety](docs/data-safety.md)).
- **Tests use synthetic data only.** Never commit real agent history, local catalogs or credentials.
- **Launch processes safely.** Pass the executable, arguments and working directory separately, and never build shell command strings from untrusted text.
- **Translate new UI text.** Write it in English inside `t('…')` (TypeScript) or `tr!("…")` (Rust), and add the Traditional Chinese translation to `src/locales/zh-TW.json`. `npm test` fails when a translation is missing. Don't speak Chinese? Leave a note in the PR and a maintainer will add it.
- **Match the code style.**
  - TypeScript: ESLint, strict mode.
  - Rust: `rustfmt` and Clippy with `-D warnings`.
  - Comments in English, and only where they explain intent.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
