# Native dialog initialization fixture

`tauri-dialog-2.8.3-init.js.txt` is the unmodified `src/init-iife.js` from the official
[tauri-plugin-dialog 2.8.3 crate](https://crates.io/crates/tauri-plugin-dialog/2.8.3),
matching the version pinned in Cargo.toml and package.json. It is distributed under
MIT OR Apache-2.0; the MIT license is included alongside this fixture.

SHA-256: `6d98742cc66d56668f4f4abac448a413a1abe48f945e16b7132942701edd92e7`.

Tests execute this source against a synthetic Tauri IPC object. This preserves the
actual Promise-returning `window.confirm` override, including native `Ok` versus
`Cancel` conversion and IPC rejection, instead of assuming browser boolean behavior.
The `.txt` extension prevents treating vendored, minified source as application code.
