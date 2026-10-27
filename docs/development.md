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
2. Merge to `main`, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. `release.yml` builds the bundles and creates a **draft** release with SHA-256 checksums.
4. Install the downloaded `.dmg` on a clean account, smoke-test it, then publish the draft.

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
- **An agent CLI is not found**: GUI apps on macOS do not inherit your shell's `PATH`. Set the absolute executable path in **Settings → Agents**.
