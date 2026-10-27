# UI UX Pro Max: upstream and local changes

## Pinned source

- Upstream: [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
- Version `v2.15.0`, commit `a38d04c3d5c298c851dbe5e6ee1965ee3de42cb5`
- Upstream path `.claude/skills/ui-ux-pro-max/`, vendored at `.agents/skills/ui-ux-pro-max/`
- All 70 files are kept, along with the upstream [MIT LICENSE](LICENSE). [upstream-manifest.json](upstream-manifest.json) records each file's Git blob SHA and size.

## Local changes

Only the run examples in `SKILL.md` are changed. They point at `REPO_ROOT/.agents/skills/` instead of `CLAUDE_PLUGIN_ROOT/.claude/skills/`, and they report a missing Python instead of installing it.

## Usage

Run from the repo root. Only the Python 3 standard library is needed.

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "component state interaction" --stack react
```

Searches only read local data. `--persist` writes design files: use it only with an `--output-dir` inside the repo, and use `--force` only when an overwrite was explicitly requested.

Two upstream test modules (`test_catalog_refresh.py`, `test_relevance_evaluator.py`) depend on maintenance scripts outside the skill folder, so they fail when run here.

## Updating

1. Pick an explicit upstream commit; never track upstream `main`.
2. Diff the whole skill folder and LICENSE against that commit.
3. Re-apply the local changes and update the manifest.
4. Review the update in its own PR.
