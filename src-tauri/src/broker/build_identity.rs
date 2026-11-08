use std::{path::Path, sync::OnceLock};

pub(super) fn current() -> Result<&'static str, String> {
    static IDENTITY: OnceLock<Result<String, String>> = OnceLock::new();
    // App and broker use the same executable. Record it once at startup so a later
    // upgrade that replaces the installed file cannot change a live host's identity.
    IDENTITY
        .get_or_init(|| of(&std::env::current_exe().map_err(|error| error.to_string())?))
        .as_deref()
        .map_err(Clone::clone)
}

/// Identity of the executable a client would start as its broker. File metadata is
/// enough: an upgrade installs a new file and a rebuild rewrites it, and reading
/// metadata stays cheap even for large debug binaries.
pub(crate) fn of(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let file = String::new();
    Ok(format!("{file}:{}:{modified}", metadata.len()))
}
