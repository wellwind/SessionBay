# Development

## Prerequisites

- Node.js 24 and npm.
- Rust, with the version pinned by `rust-toolchain.toml`. rustup installs it on the first Cargo run.
- Platform tools:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux** (Ubuntu 24.04 is the CI baseline):

    ```bash
    sudo apt-get install --no-install-recommends \
      libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev librsvg2-dev patchelf fonts-noto-cjk
    ```

  - **Windows**: Visual Studio "Desktop development with C++", the MSVC Rust toolchain and WebView2.

## Run

```bash
npm ci
npm run dev        # full desktop app (Tauri + Vite)
npm run dev:web    # UI only in a browser; no history and no terminals
```

`npm run tauri` is a small Node launcher that puts rustup's `cargo` first on `PATH`, so a Homebrew Rust does not shadow the pinned toolchain.

### Development identity

`npm run dev` applies `src-tauri/tauri.dev.conf.json` only to the `dev` subcommand. It requires a debug build and uses **Session Bay Dev** (`dev.fullstackladder.sessionbay.dev`). Local `tauri build` and the release workflow use **Session Bay** (`dev.fullstackladder.sessionbay`). Versions are unchanged by the overlay.

All worktrees share the dev profile, separate from production settings, layout, catalog, Git host tokens and broker. On macOS the folders are `~/Library/Application Support/dev.fullstackladder.sessionbay.dev` and `~/Library/Application Support/dev.fullstackladder.sessionbay`; Linux uses `~/.local/share/<identifier>`, and Windows uses `%APPDATA%/<identifier>`.

When dev has no settings yet, it imports saved production settings (including history sources, tools, shell profiles and appearance) and curated projects. **Settings → Sources and tools → Import from Session Bay** repeats this after confirmation: it replaces saved and unsaved dev settings and merges production curated project metadata, keeping dev-only projects. No index rows, boards, workspace layout, recycle bin or Git host tokens are imported. Production files are only read. The importer opens the production catalog and WAL shared memory read-only, without migrations or an index copy. Checkpointed catalogs are read without creating sidecars, with file stamps checked for concurrent changes. A catalog that changes while being read can require retrying the import. If an uncheckpointed WAL has no readable shared-memory file, open production once to recover it before retrying; dev never repairs production.

The orange DEV badge appears on the app icon and beside the top-bar logo. Its tooltip shows the branch and commit captured by the launcher, with an explicit unknown fallback outside a Git checkout. Update checks are disabled in both the dev UI and native command.

Regenerate dev icons after changing the production artwork:

```bash
node scripts/generate-dev-icons.mjs
python3 scripts/validate-macos-icon.py src-tauri/icons/dev/icon.icns
```

## Test

```bash
# Frontend
npm run typecheck && npm run lint && npm test && npm run build

# Rust core (no GUI dependencies)
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --no-default-features --all-targets -- -D warnings

# Full crate, including the desktop feature
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Browser regression tests use Playwright with a synthetic bridge, not the native WebView. Their configs live in `tests/browser/config/`:

```bash
npx playwright install chromium webkit
npm run test:browser              # every config, one after another
npm run test:browser -- tabs git  # only some configs
npm run test:sidebar              # also: test:tabs, test:layout, test:git, test:files, test:webkit, …
```

Some Monaco, activity and tab-drag specs depend on Linux key bindings and fail on macOS; CI runs them on Ubuntu.

All tests use synthetic fixtures (`fixtures/`, `tests/`). Never commit real agent history, local catalogs or credentials.

## Build

```bash
npm run tauri -- build                  # all bundles for this platform
npm run tauri -- build --bundles app    # macOS .app only
npm run tauri -- build --bundles deb    # Linux .deb only
```

Bundles are written to `src-tauri/target/release/bundle/` and are unsigned.

## CI

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `light-checks.yml` | every branch push | Ubuntu: frontend checks, Rust fmt/tests/clippy without the desktop feature. Pushes that only change Markdown docs are skipped. |
| `ci.yml` | manual | Desktop acceptance on Linux, macOS (ARM64 and Intel) and Windows: full tests, unsigned bundles and a GUI smoke test |
| `pages.yml` | push to `main` touching `website/` | Builds and deploys the website to GitHub Pages |
| `release.yml` | `v*` tag or manual | Builds the macOS Apple Silicon `.dmg` and creates a draft GitHub release |

## Releasing

1. Update the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and add a section to `CHANGELOG.md`.
2. Merge to `main`, then tag the release version, for example `git tag v0.3.0 && git push origin v0.3.0`.
3. `release.yml` builds the bundles and creates a **draft** release with SHA-256 checksums.
4. Document upgrade constraints. 0.3.0 upgrades the catalog to schema v8, which 0.2.0 cannot open. The 0.2.0 identity change starts a fresh profile from 0.1.0 and requires **Open Anyway** and notification permission again.
5. Install the downloaded `.dmg` on a clean account, smoke-test it, then publish the draft.

## Website

The website and user guide live in `website/` (Astro Starlight, English at the root and Traditional Chinese under `zh-tw/`).

```bash
cd website && npm ci && npm run dev   # http://localhost:4321/SessionBay/
```

Screenshots come from a synthetic fixture (`tests/browser/showcase.tsx`) rendered in English and Traditional Chinese. Regenerate them after UI changes:

```bash
npm run screenshots   # writes website/src/assets/screenshots/{en,zh-tw}/
```

`pages.yml` deploys the site to GitHub Pages when `website/` changes on `main`.

## macOS icon

`src-tauri/icons/icon-macos.svg` and `icon.icns` scale the artwork to 412×412 on a 512×512 canvas, so the icon matches other apps in the Dock and in Cmd+Tab. To regenerate:

```bash
node scripts/generate-macos-icon.mjs
python3 scripts/validate-macos-icon.py src-tauri/icons/icon.icns
```

## Troubleshooting

- **`Port 1420 is already in use`**: another `npm run dev` is still running. Stop it with Ctrl+C.
- **Tauri CLI panics in `interface/rust.rs`**: `rustc -vV` is broken on your `PATH`, often a Homebrew Rust that is missing LLVM libraries. Use the rustup toolchain.
- **An agent CLI is not found**: Session Bay checks `PATH`, common install locations and macOS version-manager directories. Use **Settings → Sources and tools → Detect again**, or set an absolute executable path.
- **`node` or `npm` is missing in a terminal pane**: terminals do not inherit the session state of whatever started the runtime broker (`nvm_current_version`, or `npm_*` variables when it was started by `npm run`), and shell `PATH` fallbacks leave Node versions to your version manager. A broker started before this fix keeps the old environment until it restarts.
