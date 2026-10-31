//! Read-only, bounded OpenCode SQLite reader. Official v1.19.2 source contract
//! (v1.19.3 through v1.19.5 change no database, migration, or session schema files):
//! https://github.com/anomalyco/opencode/tree/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session
//! Both v1 message/part and v2 session_message projections are supported. SQLite
//! only sees a private, persistent, owner-only mirror: the main database is
//! refreshed block-by-block (only changed blocks are written) when its identity
//! stamp changes, and the WAL is re-copied and hashed every read. Source
//! identity stamps are checked before and after reading, so no source file is
//! ever opened by SQLite, locked, checkpointed, or given a `-shm` sidecar.
//! No CLI, auth file, network request, source migration, or source write is used.
use chrono::{DateTime, SecondsFormat};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::fs;
use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

const DATABASE_NAME: &str = "opencode.db";
/// Sanity bounds only; real 2 GiB+ databases are expected. Cost now scales
/// with changed blocks and changed sessions, not with the file size.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_WAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_METADATA_ROWS: usize = 50_000;
/// Searchable text budget per session; beyond it the session is indexed up to
/// the budget and marked partial, instead of failing the whole source.
const MAX_SESSION_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MIRROR_BLOCK_BYTES: usize = 1024 * 1024;
/// Databases at or below this size are always integrity-checked; larger ones
/// only after their mirrored main database changed.
const ALWAYS_CHECK_BYTES: u64 = 64 * 1024 * 1024;
/// Test/advanced override for the private mirror location.
pub const MIRROR_DIR_ENV: &str = "SESSIONBAY_OPENCODE_MIRROR_DIR";
const BUDGET_ERROR: &str = "OpenCode session exceeds the per-session read budget";
pub const PARTIAL_WARNING: &str = "Some OpenCode sessions contain unknown versions, incomplete or ambiguous projections, or an active revert. Unsupported content is omitted; refresh after changes. Indexed resume is disabled for partial sessions.";
const BUDGET_WARNING: &str = "Some OpenCode sessions exceed the per-session read budget (100,000 messages, 10,000 parts per message, or 16 MiB of searchable text); only the leading part is searchable and those sessions are marked partial.";
const MAX_TITLE_BYTES: usize = 16 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_ERROR_BYTES: usize = 2048;
/// A v1 projection is current only when its newest row is at least this close
/// to `session.time_updated`. Real 1.19.2/1.19.3 CLI runs differ by <20 ms;
/// older residue (for example after v2 rows were deleted) stays metadata-only.
/// Bump when the reader output changes for an unchanged database, so catalog
/// rows written by an older reader are re-read instead of reused by fingerprint.
/// Revision 1: v1 fallback for empty v2 projections and the 1.19.3 version gate.
/// Revision 2: persistent block mirror, per-session fingerprints/budgets.
/// Revision 3: the version gate accepts 1.19.4 and 1.19.5.
pub const READER_REVISION: i64 = 3;
const LEGACY_FRESHNESS_MS: i64 = 60_000;

#[derive(Debug, Clone)]
pub struct ConversationMetadata {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: Option<String>,
    pub parent_id: Option<String>,
    pub archived: bool,
    pub partial: bool,
    pub messages: Vec<crate::adapters::ParsedMessage>,
    /// Per-session content fingerprint (database identity, session row, and
    /// projection row counts/timestamps). Changes whenever the session changes.
    pub fingerprint: String,
    /// Database identity (device/inode or Windows file id).
    pub identity: String,
    /// True when the caller already holds this fingerprint; messages were not read.
    pub unchanged: bool,
}

#[derive(Debug, Clone)]
pub struct IndexSummary {
    pub fingerprint: String,
    pub identity: String,
    pub warnings: Vec<String>,
    pub sessions: usize,
}

/// Counters for tests and benchmarks.
#[derive(Debug, Clone, Default)]
pub struct MirrorStats {
    pub database_bytes_read: u64,
    pub database_bytes_written: u64,
    pub database_refreshed: bool,
    pub integrity_checked: bool,
    pub sessions_read: usize,
    pub sessions_skipped: usize,
}

#[derive(Debug, Clone)]
pub struct MetadataIndex {
    pub records: HashMap<String, ConversationMetadata>,
    pub fingerprint: String,
    pub identity: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub file_bytes: u64,
    pub wal_bytes: u64,
    pub rows: usize,
    pub output_bytes: usize,
    pub block_bytes: usize,
    pub always_check_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: MAX_FILE_BYTES,
            wal_bytes: MAX_WAL_BYTES,
            rows: MAX_METADATA_ROWS,
            output_bytes: MAX_SESSION_OUTPUT_BYTES,
            block_bytes: MIRROR_BLOCK_BYTES,
            always_check_bytes: ALWAYS_CHECK_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: SystemTime,
    #[cfg(windows)]
    identity: String,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanos: i64,
}

impl Stamp {
    fn from_metadata(
        metadata: &Metadata,
        #[cfg(windows)] identity: String,
    ) -> Result<Self, String> {
        if !metadata.file_type().is_file() {
            return Err("OpenCode history source must be a regular, non-symlink file".into());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().map_err(|error| {
                format!("Cannot inspect OpenCode history modification time: {error}")
            })?,
            #[cfg(windows)]
            identity,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanos: metadata.ctime_nsec(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sources {
    database: Option<Stamp>,
    wal: Option<Stamp>,
    journal: Option<Stamp>,
}

#[derive(Clone, Copy)]
enum SnapshotStage {
    MissingChecked,
    Copied,
    Parsed,
}

/// Returns a complete bounded index or an error. Missing metadata is explicitly
/// distinguished from unreadable, changing, oversized, or unsupported metadata.
/// Collects every session in memory; the catalog uses [`read_sessions`].
pub fn read_metadata(root: &Path, cancel: &AtomicBool) -> Result<MetadataIndex, String> {
    let mut records = HashMap::new();
    let summary = read_sessions(root, cancel, &HashMap::new(), &mut |record| {
        records.insert(record.id.clone(), record);
        Ok(())
    })?;
    Ok(MetadataIndex {
        records,
        fingerprint: summary.fingerprint,
        identity: summary.identity,
        warnings: summary.warnings,
    })
}

/// Streams sessions to `sink`. Sessions whose fingerprint equals `known[id]`
/// are emitted with `unchanged = true` and no messages, so refresh cost is
/// proportional to changed sessions. The result is publishable only if this
/// returns `Ok`: sources are re-verified after the last sink call.
pub fn read_sessions(
    root: &Path,
    cancel: &AtomicBool,
    known: &HashMap<String, String>,
    sink: &mut dyn FnMut(ConversationMetadata) -> Result<(), String>,
) -> Result<IndexSummary, String> {
    read_with_limits(root, cancel, Limits::default(), known, sink).map(|(summary, _)| summary)
}

/// Like [`read_sessions`] with injected limits; returns mirror counters.
#[doc(hidden)]
pub fn read_with_limits(
    root: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    known: &HashMap<String, String>,
    sink: &mut dyn FnMut(ConversationMetadata) -> Result<(), String>,
) -> Result<(IndexSummary, MirrorStats), String> {
    // Unix uses device/inode identity; Windows uses the platform read-only
    // no-reparse handle and volume/128-bit file identity implementation.
    if !cfg!(any(unix, windows)) {
        return Err("Safe OpenCode history snapshots are unsupported on this platform".into());
    }
    let mut stats = MirrorStats::default();
    read_metadata_inner(
        root,
        cancel,
        limits,
        Mode::Full(known),
        &mut |_| {},
        sink,
        &mut stats,
    )
    .map(|summary| (summary, stats))
    .map_err(bound_error)
}

/// Verified current fingerprint of one session (None when it no longer
/// exists). Used before previews and cold resumes; reads no message rows.
pub fn session_fingerprint(root: &Path, id: &str) -> Result<Option<String>, String> {
    let mut found = None;
    read_metadata_inner(
        root,
        &AtomicBool::new(false),
        Limits::default(),
        Mode::Only(id),
        &mut |_| {},
        &mut |record| {
            found = Some(record.fingerprint);
            Ok(())
        },
        &mut MirrorStats::default(),
    )
    .map_err(bound_error)?;
    Ok(found)
}

#[derive(Clone, Copy)]
enum Mode<'a> {
    Full(&'a HashMap<String, String>),
    Only(&'a str),
}

fn bound_error(mut error: String) -> String {
    if error.len() > MAX_ERROR_BYTES {
        let mut end = MAX_ERROR_BYTES - 3;
        while !error.is_char_boundary(end) {
            end -= 1;
        }
        error.truncate(end);
        error.push_str("...");
    }
    error
}

fn read_metadata_inner(
    root: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    mode: Mode,
    hook: &mut dyn FnMut(SnapshotStage),
    sink: &mut dyn FnMut(ConversationMetadata) -> Result<(), String>,
    stats: &mut MirrorStats,
) -> Result<IndexSummary, String> {
    check_cancel(cancel)?;
    let sources = inspect_sources(root, limits)?;
    let Some(database_stamp) = sources.database.as_ref() else {
        if sources.wal.is_some() || sources.journal.is_some() {
            return Err(
                "OpenCode history database is missing but sidecars exist; snapshot is uncertain"
                    .into(),
            );
        }
        hook(SnapshotStage::MissingChecked);
        check_cancel(cancel)?;
        ensure_sources(root, &sources, limits)?;
        return Ok(IndexSummary {
            identity: "missing".into(),
            fingerprint: format!("{:x}", Sha256::digest(b"opencode-metadata-v1:missing")),
            sessions: 0,
            warnings: vec![if root.join("storage/session").exists() {
                "Legacy OpenCode JSON storage is not supported. OpenCode must perform its own migration; Session Bay never migrates or writes history.".into()
            } else {
                "OpenCode opencode.db is missing; no SQLite sessions are available yet.".into()
            }],
        });
    };

    let mirror = open_mirror(root)?;
    let database_path = root.join(DATABASE_NAME);
    let database_copy = mirror.dir.join(DATABASE_NAME);
    let stamp_file = mirror.dir.join("source.stamp");
    let stamp_text = format!("{database_stamp:?}");
    let previous_state = std::fs::read_to_string(&stamp_file).ok();
    let reusable = previous_state
        .as_deref()
        .and_then(|text| text.split_once('\n'))
        .is_some_and(|(stamp, _)| stamp == stamp_text)
        && std::fs::symlink_metadata(&database_copy)
            .is_ok_and(|meta| meta.is_file() && meta.len() == database_stamp.len);
    let previously_checked = reusable
        && previous_state
            .as_deref()
            .is_some_and(|text| text.ends_with("\nchecked"));
    if !reusable {
        let _ = std::fs::remove_file(&stamp_file);
        refresh_database(
            &database_path,
            database_stamp,
            &database_copy,
            limits,
            cancel,
            stats,
        )?;
        stats.database_refreshed = true;
    }
    // SQLite only ever sees the mirror; drop stale sidecars from earlier reads.
    for suffix in ["wal", "shm", "journal"] {
        match std::fs::remove_file(sidecar(&mirror.dir, suffix)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot reset private OpenCode mirror: {error}")),
        }
    }
    let wal_hash = match sources.wal.as_ref() {
        Some(stamp) => Some(copy_and_hash(
            &sidecar(root, "wal"),
            &sidecar(&mirror.dir, "wal"),
            stamp,
            cancel,
        )?),
        None => None,
    };
    // Nonempty journals were rejected; do not ask SQLite to recover any journal.
    let journal_hash = sources
        .journal
        .as_ref()
        .map(|stamp| hash_source(&sidecar(root, "journal"), stamp, cancel))
        .transpose()?;
    hook(SnapshotStage::Copied);
    let hashes = [
        wal_hash.as_deref().unwrap_or(""),
        journal_hash.as_deref().unwrap_or(""),
    ];
    // Main-database consistency is proven by its identity stamp (device/inode,
    // size, nanosecond mtime/ctime) being identical before and after: every
    // write, including checkpoints, updates mtime/ctime. WAL/journal content is
    // small and is additionally re-hashed.
    verify_snapshot_sources(root, &sources, hashes, limits, cancel)?;
    if !reusable {
        write_stamp(&stamp_file, &stamp_text, false)?;
    }

    let snapshot_warning =
        validate_sqlite_files(&database_copy, sources.wal.is_some(), limits, cancel)?;
    check_cancel(cancel)?;
    let integrity = !previously_checked || database_stamp.len <= limits.always_check_bytes;
    stats.integrity_checked = integrity;
    let identity = stamp_identity(database_stamp);
    let mut summary = read_copy(
        &database_copy,
        limits,
        cancel,
        integrity,
        mode,
        &identity,
        sink,
        stats,
    )?;
    if integrity && !previously_checked {
        write_stamp(&stamp_file, &stamp_text, true)?;
    }
    if let Some(warning) = snapshot_warning {
        summary.warnings.insert(0, warning.into());
    }
    hook(SnapshotStage::Parsed);
    // A result based on a source that changed during parsing is not publishable.
    verify_snapshot_sources(root, &sources, hashes, limits, cancel)?;
    let mut fingerprint = Sha256::new();
    fingerprint.update(b"opencode-metadata-v2\0");
    fingerprint.update(format!("{sources:?}").as_bytes());
    for hash in [wal_hash.as_deref(), journal_hash.as_deref()] {
        match hash {
            Some(hash) => {
                fingerprint.update(b"present:");
                fingerprint.update(hash.as_bytes());
            }
            None => fingerprint.update(b"missing"),
        }
        fingerprint.update([0]);
    }
    summary.identity = identity;
    summary.fingerprint = format!("{:x}", fingerprint.finalize());
    Ok(summary)
}

fn write_stamp(path: &Path, stamp: &str, checked: bool) -> Result<(), String> {
    let state = if checked { "checked" } else { "copied" };
    std::fs::write(path, format!("{stamp}\n{state}"))
        .map_err(|error| format!("Cannot record private OpenCode mirror state: {error}"))
}

struct Mirror {
    dir: PathBuf,
    _lock: File,
}

fn mirror_base() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(MIRROR_DIR_ENV).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::cache_dir()
        .map(|dir| dir.join("sessionbay").join("opencode-mirror"))
        .ok_or_else(|| "Cannot locate a private cache directory for the OpenCode mirror".into())
}

fn private_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir_all(path);
    created.map_err(|error| format!("Cannot create private OpenCode mirror: {error}"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect private OpenCode mirror: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Private OpenCode mirror must be a real, non-symlink directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Private OpenCode mirror is owned by another user".into());
        }
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Cannot restrict private OpenCode mirror: {error}"))?;
        }
    }
    Ok(())
}

/// One mirror per source root, serialized across threads and processes.
fn open_mirror(root: &Path) -> Result<Mirror, String> {
    let base = mirror_base()?;
    let key = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
    let dir = base.join(&key[..32]);
    private_dir(&base)?;
    private_dir(&dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("lock"))
        .map_err(|error| format!("Cannot open private OpenCode mirror lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot lock private OpenCode mirror: {error}"))?;
    Ok(Mirror { dir, _lock: lock })
}

fn read_full(file: &mut File, buffer: &mut [u8]) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("Cannot read private OpenCode mirror: {error}")),
        }
    }
    Ok(filled)
}

/// Brings the private mirror byte-identical to the source database, writing
/// only blocks that differ. The source identity must be unchanged afterwards.
fn refresh_database(
    source_path: &Path,
    expected: &Stamp,
    mirror_path: &Path,
    limits: Limits,
    cancel: &AtomicBool,
    stats: &mut MirrorStats,
) -> Result<(), String> {
    let mut source = open_source(source_path, expected)?;
    if std::fs::symlink_metadata(mirror_path).is_ok_and(|meta| !meta.is_file()) {
        return Err("Private OpenCode mirror database is not a regular file".into());
    }
    let mut mirror = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(mirror_path)
        .map_err(|error| format!("Cannot open private OpenCode mirror: {error}"))?;
    let block = limits.block_bytes.max(4096);
    let mut wanted = vec![0_u8; block];
    let mut current = vec![0_u8; block];
    let mut offset = 0_u64;
    while offset < expected.len {
        check_cancel(cancel)?;
        let count = usize::try_from((expected.len - offset).min(block as u64)).unwrap();
        source
            .read_exact(&mut wanted[..count])
            .map_err(|error| format!("OpenCode history could not be read completely: {error}"))?;
        let have = read_full(&mut mirror, &mut current[..count])?;
        if have < count || wanted[..count] != current[..count] {
            mirror
                .seek(SeekFrom::Start(offset))
                .and_then(|_| mirror.write_all(&wanted[..count]))
                .map_err(|error| format!("Cannot write private OpenCode mirror: {error}"))?;
            stats.database_bytes_written += count as u64;
        }
        stats.database_bytes_read += count as u64;
        offset += count as u64;
    }
    let mut extra = [0_u8; 1];
    if source
        .read(&mut extra)
        .map_err(|error| format!("Cannot finish OpenCode history source read: {error}"))?
        != 0
    {
        return Err("OpenCode history grew while reading".into());
    }
    mirror
        .set_len(expected.len)
        .map_err(|error| format!("Cannot size private OpenCode mirror: {error}"))?;
    verify_file_identity(source_path, &source, expected)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("OpenCode history read cancelled".into())
    } else {
        Ok(())
    }
}

fn sidecar(root: &Path, suffix: &str) -> PathBuf {
    root.join(format!("{DATABASE_NAME}-{suffix}"))
}

fn inspect_file(path: &Path, limits: Limits) -> Result<Option<Stamp>, String> {
    #[cfg(windows)]
    let inspected = crate::windows_fs::open_regular_readonly_nofollow(path);
    #[cfg(not(windows))]
    let inspected = fs::symlink_metadata(path);
    match inspected {
        Ok(metadata) => {
            #[cfg(not(windows))]
            let stamp = Stamp::from_metadata(&metadata)?;
            #[cfg(windows)]
            let stamp = windows_stamp(&metadata)?;
            if stamp.len > limits.file_bytes {
                return Err(format!(
                    "OpenCode history file is larger than the {} GiB safety bound",
                    limits.file_bytes >> 30
                ));
            }
            Ok(Some(stamp))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot inspect OpenCode history source: {error}")),
    }
}

fn inspect_sources(root: &Path, limits: Limits) -> Result<Sources, String> {
    let sources = Sources {
        database: inspect_file(&root.join(DATABASE_NAME), limits)?,
        wal: inspect_file(&sidecar(root, "wal"), limits)?,
        journal: inspect_file(&sidecar(root, "journal"), limits)?,
    };
    if sources.journal.as_ref().is_some_and(|stamp| stamp.len != 0) {
        return Err("OpenCode history has a nonempty rollback journal; a hot or uncertain journal cannot be safely read".into());
    }
    // The WAL is copied in full on every read, so it keeps its own bound.
    if sources
        .wal
        .as_ref()
        .is_some_and(|stamp| stamp.len > limits.wal_bytes)
    {
        return Err(
            "OpenCode history WAL exceeds the copy byte limit; let OpenCode checkpoint and refresh"
                .into(),
        );
    }
    Ok(sources)
}

fn ensure_sources(root: &Path, expected: &Sources, limits: Limits) -> Result<(), String> {
    if inspect_sources(root, limits)? != *expected {
        return Err(
            "OpenCode history changed while reading; retry after the writer settles".into(),
        );
    }
    Ok(())
}

fn open_source(path: &Path, expected: &Stamp) -> Result<File, String> {
    #[cfg(not(windows))]
    let file = {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Reject symlink races and do not block if a regular file became a FIFO.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options
            .open(path)
            .map_err(|error| format!("Cannot open OpenCode history source read-only: {error}"))?;
        file
    };
    #[cfg(windows)]
    let file = crate::windows_fs::open_regular_readonly_nofollow(path)
        .map_err(|error| format!("Cannot open OpenCode history source read-only: {error}"))?;
    verify_file_identity(path, &file, expected)?;
    Ok(file)
}

#[cfg(windows)]
fn windows_stamp(file: &File) -> Result<Stamp, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect OpenCode source: {error}"))?;
    let identity = crate::windows_fs::identity_from_file(file)
        .map_err(|error| format!("Cannot verify OpenCode source identity: {error}"))?;
    Stamp::from_metadata(&metadata, identity)
}

fn verify_file_identity(path: &Path, file: &File, expected: &Stamp) -> Result<(), String> {
    #[cfg(not(windows))]
    let (descriptor, pathname) = {
        let descriptor = file
            .metadata()
            .map_err(|error| format!("Cannot inspect open OpenCode history source: {error}"))?;
        let pathname = fs::symlink_metadata(path)
            .map_err(|error| format!("OpenCode history source changed or disappeared: {error}"))?;
        (
            Stamp::from_metadata(&descriptor)?,
            Stamp::from_metadata(&pathname)?,
        )
    };
    #[cfg(windows)]
    let (descriptor, pathname) = {
        let pathname = crate::windows_fs::open_regular_readonly_nofollow(path)
            .map_err(|error| format!("OpenCode history source changed or disappeared: {error}"))?;
        (windows_stamp(file)?, windows_stamp(&pathname)?)
    };
    if descriptor != *expected || pathname != *expected {
        return Err(
            "OpenCode history source identity, size, or timestamps changed while reading".into(),
        );
    }
    Ok(())
}

fn stream_source(
    path: &Path,
    expected: &Stamp,
    cancel: &AtomicBool,
    mut destination: Option<&mut File>,
) -> Result<String, String> {
    let mut source = open_source(path, expected)?;
    let mut hash = Sha256::new();
    let mut remaining = expected.len;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        check_cancel(cancel)?;
        let count = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
        source
            .read_exact(&mut buffer[..count])
            .map_err(|error| format!("OpenCode history could not be read completely: {error}"))?;
        hash.update(&buffer[..count]);
        if let Some(output) = destination.as_mut() {
            output.write_all(&buffer[..count]).map_err(|error| {
                format!("Cannot write private OpenCode history snapshot: {error}")
            })?;
        }
        remaining -= count as u64;
    }
    check_cancel(cancel)?;
    let mut extra = [0_u8; 1];
    if source
        .read(&mut extra)
        .map_err(|error| format!("Cannot finish OpenCode history source read: {error}"))?
        != 0
    {
        return Err("OpenCode history grew while reading".into());
    }
    verify_file_identity(path, &source, expected)?;
    Ok(format!("{:x}", hash.finalize()))
}

fn hash_source(path: &Path, expected: &Stamp, cancel: &AtomicBool) -> Result<String, String> {
    stream_source(path, expected, cancel, None)
}

fn copy_and_hash(
    path: &Path,
    destination: &Path,
    expected: &Stamp,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Cannot create private OpenCode history copy: {error}"))?;
    stream_source(path, expected, cancel, Some(&mut copy))
}

fn verify_snapshot_sources(
    root: &Path,
    expected: &Sources,
    hashes: [&str; 2],
    limits: Limits,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancel)?;
    ensure_sources(root, expected, limits)?;
    for ((path, stamp), expected_hash) in [
        (sidecar(root, "wal"), &expected.wal),
        (sidecar(root, "journal"), &expected.journal),
    ]
    .into_iter()
    .zip(hashes)
    {
        if let Some(stamp) = stamp {
            if hash_source(&path, stamp, cancel)? != expected_hash {
                return Err("OpenCode history content changed while reading".into());
            }
        }
    }
    ensure_sources(root, expected, limits)
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four-byte SQLite field"))
}

fn checksum(bytes: &[u8], big_endian: bool, state: &mut [u32; 2]) {
    for words in bytes.as_chunks::<8>().0 {
        let word = |bytes: &[u8]| {
            if big_endian {
                be32(bytes)
            } else {
                u32::from_le_bytes(bytes.try_into().expect("four-byte SQLite field"))
            }
        };
        state[0] = state[0]
            .wrapping_add(word(&words[..4]))
            .wrapping_add(state[1]);
        state[1] = state[1]
            .wrapping_add(word(&words[4..]))
            .wrapping_add(state[0]);
    }
}

/// Validate current-generation WAL frames so damaged commits cannot be silently
/// ignored. SQLite resets may leave previous-generation tail frames; trim those
/// only in the private copy, to the last validated commit, and report a warning.
/// Reference: https://www.sqlite.org/fileformat2.html#walformat
fn validate_sqlite_files(
    database: &Path,
    has_wal: bool,
    limits: Limits,
    cancel: &AtomicBool,
) -> Result<Option<&'static str>, String> {
    let mut file = File::open(database)
        .map_err(|error| format!("Cannot open private OpenCode history copy: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 100];
    file.read_exact(&mut header)
        .map_err(|_| "OpenCode history database has an incomplete SQLite header".to_string())?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err("OpenCode history database is not a supported SQLite database".into());
    }
    let page_field = u16::from_be_bytes([header[16], header[17]]);
    let page_size = if page_field == 1 {
        65_536
    } else {
        u32::from(page_field)
    };
    if !(512..=65_536).contains(&page_size)
        || !page_size.is_power_of_two()
        || length % u64::from(page_size) != 0
        || ![1, 2].contains(&header[18])
        || ![1, 2].contains(&header[19])
    {
        return Err("OpenCode history database has an invalid SQLite page layout".into());
    }
    if header[24..28] == header[92..96]
        && u64::from(be32(&header[28..32])) * u64::from(page_size) > limits.file_bytes
    {
        return Err("OpenCode history logical database size exceeds the byte limit".into());
    }
    if !has_wal {
        return Ok(None);
    }
    let wal_path = database.with_file_name(format!("{DATABASE_NAME}-wal"));
    let mut wal = File::open(&wal_path).map_err(|error| error.to_string())?;
    let wal_length = wal.metadata().map_err(|error| error.to_string())?.len();
    if wal_length == 0 {
        return Ok(None);
    }
    let frame_size = 24 + u64::from(page_size);
    if wal_length < 32 || (wal_length - 32) % frame_size != 0 {
        return Err("OpenCode history WAL is incomplete; refusing a partial snapshot".into());
    }
    let mut wal_header = [0_u8; 32];
    wal.read_exact(&mut wal_header)
        .map_err(|error| error.to_string())?;
    let magic = be32(&wal_header[..4]);
    if ![0x377f0682, 0x377f0683].contains(&magic)
        || be32(&wal_header[4..8]) != 3_007_000
        || be32(&wal_header[8..12]) != page_size
        || header[18] != 2
        || header[19] != 2
    {
        return Err("OpenCode history WAL has an unsupported or mismatched header".into());
    }
    let big_endian = magic == 0x377f0683;
    let mut state = [0_u32; 2];
    checksum(&wal_header[..24], big_endian, &mut state);
    if state != [be32(&wal_header[24..28]), be32(&wal_header[28..32])] {
        return Err("OpenCode history WAL header checksum is invalid".into());
    }
    let mut frame = vec![0_u8; frame_size as usize];
    let mut stale_tail = false;
    let mut last_committed_end = 32;
    for index in 0..(wal_length - 32) / frame_size {
        check_cancel(cancel)?;
        wal.read_exact(&mut frame)
            .map_err(|error| error.to_string())?;
        if be32(&frame[..4]) == 0 {
            return Err("OpenCode history WAL contains an invalid frame page number".into());
        }
        if frame[8..16] != wal_header[16..24] {
            // Reset increments salt-1. Require a previous generation, rather
            // than treating a changed salt-2 alone as harmless historical data.
            let age = be32(&wal_header[16..20]).wrapping_sub(be32(&frame[8..12]));
            if age == 0 || age > i32::MAX as u32 {
                return Err(
                    "OpenCode history WAL contains an uncertain generation mismatch".into(),
                );
            }
            stale_tail = true;
            continue;
        }
        if stale_tail {
            return Err("OpenCode history WAL has current frames after stale frames; refusing an uncertain snapshot".into());
        }
        if [be32(&frame[..4]), be32(&frame[4..8])]
            .iter()
            .any(|pages| u64::from(*pages) * u64::from(page_size) > limits.file_bytes)
        {
            return Err("OpenCode history WAL exceeds the logical database byte limit".into());
        }
        checksum(&frame[..8], big_endian, &mut state);
        checksum(&frame[24..], big_endian, &mut state);
        if state != [be32(&frame[16..20]), be32(&frame[20..24])] {
            return Err(
                "OpenCode history WAL frame checksum is invalid; refusing a partial snapshot"
                    .into(),
            );
        }
        if be32(&frame[4..8]) != 0 {
            last_committed_end = 32 + (index + 1) * frame_size;
        }
    }
    if stale_tail {
        drop(wal);
        check_cancel(cancel)?;
        // The original path is never passed here. Source bytes and fingerprints
        // still include the full, unchanged WAL, including its historical tail.
        OpenOptions::new()
            .write(true)
            .open(&wal_path)
            .and_then(|file| file.set_len(last_committed_end))
            .map_err(|error| format!("Cannot trim the private OpenCode WAL snapshot: {error}"))?;
        return Ok(Some("OpenCode history WAL retained previous-generation frames; the private snapshot was limited to its last validated commit"));
    }
    Ok(None)
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("Cannot read OpenCode history snapshot: {error}")
}

#[allow(clippy::too_many_arguments)]
fn read_copy(
    database: &Path,
    limits: Limits,
    cancel: &AtomicBool,
    integrity: bool,
    mode: Mode,
    identity: &str,
    sink: &mut dyn FnMut(ConversationMetadata) -> Result<(), String>,
    stats: &mut MirrorStats,
) -> Result<IndexSummary, String> {
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql_error)?;
    with_sqlite_cancellation(&connection, cancel, || {
        read_connection(
            &connection,
            limits,
            cancel,
            integrity,
            mode,
            identity,
            sink,
            stats,
        )
    })
}

fn with_sqlite_cancellation<T>(
    connection: &Connection,
    cancel: &AtomicBool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    check_cancel(cancel)?;
    // Buffer/row checks cannot cancel SQLite during a large B-tree traversal.
    // This handle can only interrupt the private snapshot connection.
    let interrupt = connection.get_interrupt_handle();
    std::thread::scope(|scope| {
        let (finished, receive_finished) = std::sync::mpsc::sync_channel(1);
        scope.spawn(move || loop {
            match receive_finished.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::Relaxed) {
                        interrupt.interrupt();
                    }
                }
            }
        });
        let result = operation();
        let _ = finished.send(());
        check_cancel(cancel)?;
        result
    })
}

fn columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let ordinary: Option<(String, i64)> = connection
        .query_row(
            "SELECT type,rootpage FROM sqlite_schema WHERE name=?1",
            [table],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql_error)?;
    if !matches!(ordinary, Some((kind, page)) if kind == "table" && page > 0) {
        return Err(format!(
            "Unsupported OpenCode schema: {table} must be an ordinary table"
        ));
    }
    // The table names below are compiled constants, never untrusted SQL.
    let fields = connection
        .prepare(&format!("PRAGMA table_xinfo({table})"))
        .map_err(sql_error)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(6)?))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    if fields.iter().any(|(_, hidden)| *hidden != 0) {
        return Err(format!(
            "Unsupported OpenCode schema: {table} contains generated or hidden columns"
        ));
    }
    Ok(fields.into_iter().map(|(name, _)| name).collect())
}
fn require_columns(
    connection: &Connection,
    table: &str,
    required: &[&str],
) -> Result<HashSet<String>, String> {
    let actual = columns(connection, table)?;
    if required.iter().any(|column| !actual.contains(*column)) {
        return Err(format!(
            "Unsupported OpenCode schema: {table} is missing required columns"
        ));
    }
    Ok(actual)
}
fn millis(value: i64) -> Option<String> {
    DateTime::from_timestamp_millis(value)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
}
pub fn valid_session_id(id: &str) -> bool {
    id.starts_with("ses_")
        && id.len() > 4
        && id.len() <= 256
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn reviewed_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let parsed: Option<Vec<u32>> = parts.into_iter().map(|p| p.parse().ok()).collect();
    parsed.is_some_and(|p| p[0] == 1 && (p[1] < 19 || (p[1] == 19 && p[2] <= 5)))
}
#[allow(clippy::too_many_arguments)]
fn read_connection(
    connection: &Connection,
    limits: Limits,
    cancel: &AtomicBool,
    integrity: bool,
    mode: Mode,
    identity: &str,
    sink: &mut dyn FnMut(ConversationMetadata) -> Result<(), String>,
    stats: &mut MirrorStats,
) -> Result<IndexSummary, String> {
    connection
        .execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON;",
        )
        .map_err(sql_error)?;
    // quick_check is O(database). It runs whenever the mirrored main database
    // changed (or is small); WAL frames are checksum-validated on every read
    // and B-tree corruption still fails queries via cell_size_check.
    if integrity {
        let integrity: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(sql_error)?;
        if integrity != "ok" {
            return Err("OpenCode snapshot failed SQLite integrity checking".into());
        }
    }
    require_columns(
        connection,
        "session",
        &[
            "id",
            "directory",
            "title",
            "version",
            "time_updated",
            "parent_id",
            "time_archived",
            "revert",
        ],
    )?;
    let has_v2: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='session_message')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    if has_v2 {
        require_columns(
            connection,
            "session_message",
            &["id", "session_id", "type", "seq", "time_created", "data"],
        )?;
    }
    require_columns(
        connection,
        "message",
        &["id", "session_id", "time_created", "time_updated", "data"],
    )?;
    require_columns(
        connection,
        "part",
        &["id", "session_id", "message_id", "time_updated", "data"],
    )?;
    let mut seen = HashSet::new();
    let mut warnings: Vec<String> = Vec::new();
    let only = match mode {
        Mode::Only(id) => Some(id),
        Mode::Full(_) => None,
    };
    let mut statement = connection.prepare(
        "SELECT id,directory,title,version,time_updated,parent_id,time_archived,revert IS NOT NULL FROM session WHERE ?2 IS NULL OR id=?2 LIMIT ?1"
    ).map_err(sql_error)?;
    let counts_sql = if has_v2 {
        "SELECT (SELECT count(*) FROM message WHERE session_id=?1),(SELECT max(time_created) FROM message WHERE session_id=?1),(SELECT max(time_updated) FROM message WHERE session_id=?1),(SELECT count(*) FROM part WHERE session_id=?1),(SELECT count(*) FROM session_message WHERE session_id=?1),(SELECT max(seq) FROM session_message WHERE session_id=?1)"
    } else {
        "SELECT (SELECT count(*) FROM message WHERE session_id=?1),(SELECT max(time_created) FROM message WHERE session_id=?1),(SELECT max(time_updated) FROM message WHERE session_id=?1),(SELECT count(*) FROM part WHERE session_id=?1),0,NULL"
    };
    let mut counts = connection.prepare(counts_sql).map_err(sql_error)?;
    let mut rows = statement
        .query(rusqlite::params![limits.rows + 1, only])
        .map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancel(cancel)?;
        if seen.len() >= limits.rows {
            return Err("OpenCode session count exceeds the read limit".into());
        }
        let id: String = row.get(0).map_err(sql_error)?;
        if !valid_session_id(&id) {
            return Err("OpenCode session has an unsafe identity".into());
        }
        let cwd: String = row.get(1).map_err(sql_error)?;
        let title: String = row.get(2).map_err(sql_error)?;
        let version: String = row.get(3).map_err(sql_error)?;
        let updated_raw: i64 = row.get(4).map_err(sql_error)?;
        let updated_at = millis(updated_raw);
        let parent_id: Option<String> = row.get(5).map_err(sql_error)?;
        let archived = row.get::<_, Option<i64>>(6).map_err(sql_error)?.is_some();
        let reverted: bool = row.get(7).map_err(sql_error)?;
        if cwd.len() > MAX_PATH_BYTES
            || title.len() > MAX_TITLE_BYTES
            || version.len() > 64
            || parent_id.as_ref().is_some_and(|id| !valid_session_id(id))
        {
            return Err("OpenCode session metadata exceeds supported bounds".into());
        }
        if !seen.insert(id.clone()) {
            return Err("Multiple OpenCode rows claim the same session identity".into());
        }
        // Index-only counts plus small message rows; large part payloads
        // (tool output) are never touched to fingerprint a session.
        let projection: (i64, Option<i64>, Option<i64>, i64, i64, Option<i64>) = counts
            .query_row([&id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(sql_error)?;
        let mut digest = Sha256::new();
        digest.update(
            format!(
                "opencode-session-v{READER_REVISION}\0{identity}\0{id}\0{cwd}\0{title}\0{version}\0{updated_raw}\0{parent_id:?}\0{archived}\0{reverted}\0{projection:?}"
            )
            .as_bytes(),
        );
        let fingerprint = format!("{:x}", digest.finalize());
        let unchanged = match mode {
            Mode::Only(_) => true,
            Mode::Full(known) => known.get(&id) == Some(&fingerprint),
        };
        let mut record = ConversationMetadata {
            id: id.clone(),
            title: Some(title),
            cwd: (!cwd.is_empty()).then_some(cwd),
            updated_at,
            parent_id,
            archived,
            partial: !reviewed_version(&version) || reverted,
            messages: vec![],
            fingerprint,
            identity: identity.to_owned(),
            unchanged,
        };
        if unchanged {
            stats.sessions_skipped += 1;
            sink(record)?;
            continue;
        }
        stats.sessions_read += 1;
        let mut output_bytes = 0usize;
        // Unknown producer versions and reverted sessions expose metadata only.
        // Never resurrect hidden content from an older projection or compaction.
        let content = (|| -> Result<(), String> {
            if record.partial {
                return Ok(());
            }
            let v2: bool = has_v2
                && connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM session_message WHERE session_id=?1)",
                        [&id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
            if v2 {
                read_v2(connection, &mut record, cancel, &mut output_bytes, limits)?;
            } else if has_v2 {
                // The stable 1.19.x CLI writes only the v1 message/part
                // projection, so an empty v2 projection alone is not a
                // conflict. v1 is read only when it is as fresh as the
                // session row; stale v1 residue (for example after v2 rows
                // were deleted) is still treated as ambiguous metadata-only.
                match latest_legacy_update(connection, &id)? {
                    None => {}
                    Some(latest) if latest.saturating_add(LEGACY_FRESHNESS_MS) >= updated_raw => {
                        read_v1(connection, &mut record, cancel, &mut output_bytes, limits)?;
                    }
                    Some(_) => record.partial = true,
                }
            } else {
                read_v1(connection, &mut record, cancel, &mut output_bytes, limits)?;
            }
            Ok(())
        })();
        match content {
            Ok(()) => {}
            Err(error) if error == BUDGET_ERROR => {
                record.partial = true;
                if !warnings.iter().any(|warning| warning == BUDGET_WARNING) {
                    warnings.push(BUDGET_WARNING.into());
                }
            }
            Err(error) => return Err(error),
        }
        record.partial |= record.updated_at.is_none();
        if record.partial && !warnings.iter().any(|warning| warning == PARTIAL_WARNING) {
            warnings.push(PARTIAL_WARNING.into());
        }
        sink(record)?;
    }
    Ok(IndexSummary {
        fingerprint: String::new(),
        identity: String::new(),
        sessions: seen.len(),
        warnings,
    })
}
fn push_message(
    record: &mut ConversationMetadata,
    role: &str,
    text: String,
    timestamp: Option<String>,
    output: &mut usize,
    limits: Limits,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    *output = output
        .checked_add(text.len())
        .ok_or("OpenCode output size overflow")?;
    if *output > limits.output_bytes {
        return Err(BUDGET_ERROR.into());
    }
    record.partial |= timestamp.is_none();
    record.messages.push(crate::adapters::ParsedMessage {
        role: role.into(),
        text,
        timestamp,
        searchable: true,
        fallback: false,
    });
    Ok(())
}
fn latest_legacy_update(connection: &Connection, id: &str) -> Result<Option<i64>, String> {
    connection
        .query_row(
            "SELECT max(t) FROM (SELECT max(time_updated) AS t FROM message WHERE session_id=?1 UNION ALL SELECT max(time_updated) FROM part WHERE session_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(sql_error)
}
fn read_v2(
    connection: &Connection,
    record: &mut ConversationMetadata,
    cancel: &AtomicBool,
    output: &mut usize,
    limits: Limits,
) -> Result<(), String> {
    let mut statement = connection.prepare("SELECT type,seq,time_created,CASE WHEN length(CAST(data AS BLOB))<=8388608 THEN data END FROM session_message WHERE session_id=?1 ORDER BY seq,id LIMIT 100001").map_err(sql_error)?;
    let mut rows = statement.query([&record.id]).map_err(sql_error)?;
    let mut count = 0;
    let mut previous = None;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancel(cancel)?;
        count += 1;
        if count > 100_000 {
            return Err(BUDGET_ERROR.into());
        }
        let kind: String = row.get(0).map_err(sql_error)?;
        let sequence: i64 = row.get(1).map_err(sql_error)?;
        if sequence < 0 || previous.is_some_and(|old| sequence <= old) {
            return Err("Conflicting OpenCode message sequence".into());
        }
        previous = Some(sequence);
        let timestamp = millis(row.get(2).map_err(sql_error)?);
        let data: Option<String> = row.get(3).map_err(sql_error)?;
        let Some(value) = data.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            record.partial = true;
            continue;
        };
        let text = match kind.as_str() {
            "user" => value.get("text").and_then(Value::as_str).map(str::to_owned),
            "assistant" => value
                .get("content")
                .and_then(Value::as_array)
                .map(|content| {
                    let mut text = Vec::new();
                    for part in content {
                        match part.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(value) = part.get("text").and_then(Value::as_str) {
                                    text.push(value);
                                } else {
                                    record.partial = true;
                                }
                            }
                            Some("reasoning" | "tool") => {}
                            _ => record.partial = true,
                        }
                    }
                    text.join("\n\n")
                }),
            "compaction" | "synthetic" | "system" | "shell" | "agent-switched"
            | "model-switched" => continue,
            _ => {
                record.partial = true;
                continue;
            }
        };
        if let Some(text) = text {
            push_message(record, &kind, text, timestamp, output, limits)?;
        } else {
            record.partial = true;
        }
    }
    Ok(())
}
fn read_v1(
    connection: &Connection,
    record: &mut ConversationMetadata,
    cancel: &AtomicBool,
    output: &mut usize,
    limits: Limits,
) -> Result<(), String> {
    let mut statement = connection.prepare("SELECT id,time_created,CASE WHEN length(CAST(data AS BLOB))<=8388608 THEN data END FROM message WHERE session_id=?1 ORDER BY time_created,id LIMIT 100001").map_err(sql_error)?;
    let mut rows = statement.query([&record.id]).map_err(sql_error)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancel(cancel)?;
        count += 1;
        if count > 100_000 {
            return Err(BUDGET_ERROR.into());
        }
        let id: String = row.get(0).map_err(sql_error)?;
        let timestamp = millis(row.get(1).map_err(sql_error)?);
        let data: Option<String> = row.get(2).map_err(sql_error)?;
        let Some(value) = data.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            record.partial = true;
            continue;
        };
        let Some(role @ ("user" | "assistant")) = value.get("role").and_then(Value::as_str) else {
            record.partial = true;
            continue;
        };
        if role == "assistant"
            && value
                .get("summary")
                .is_some_and(|value| !value.is_boolean())
        {
            record.partial = true;
            continue;
        }
        if role == "assistant" && value.get("summary") == Some(&Value::Bool(true)) {
            continue;
        }
        let mut parts = connection.prepare("SELECT CASE WHEN length(CAST(data AS BLOB))<=8388608 THEN data END FROM part WHERE session_id=?1 AND message_id=?2 ORDER BY id LIMIT 10001").map_err(sql_error)?;
        let values = parts
            .query_map([&record.id, &id], |row| row.get::<_, Option<String>>(0))
            .map_err(sql_error)?;
        let mut text = Vec::new();
        let mut bytes = 0;
        for (index, part) in values.enumerate() {
            check_cancel(cancel)?;
            if index == 10_000 {
                return Err(BUDGET_ERROR.into());
            }
            let Some(value) = part
                .map_err(sql_error)?
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            else {
                record.partial = true;
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if ["ignored", "synthetic"]
                        .iter()
                        .any(|field| value.get(field).is_some_and(|value| !value.is_boolean()))
                    {
                        record.partial = true;
                        continue;
                    }
                    if value.get("ignored") == Some(&Value::Bool(true))
                        || value.get("synthetic") == Some(&Value::Bool(true))
                    {
                        continue;
                    }
                    if let Some(value) = value.get("text").and_then(Value::as_str) {
                        bytes += value.len();
                        if bytes > limits.output_bytes {
                            return Err(BUDGET_ERROR.into());
                        }
                        text.push(value.to_owned());
                    } else {
                        record.partial = true;
                    }
                }
                Some(
                    "reasoning" | "tool" | "file" | "snapshot" | "patch" | "agent" | "retry"
                    | "step-start" | "step-finish" | "compaction" | "subtask",
                ) => {}
                _ => record.partial = true,
            }
        }
        push_message(record, role, text.join("\n\n"), timestamp, output, limits)?;
    }
    Ok(())
}

fn stamp_identity(stamp: &Stamp) -> String {
    #[cfg(windows)]
    {
        stamp.identity.clone()
    }
    #[cfg(unix)]
    {
        format!("{}:{}", stamp.device, stamp.inode)
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("{}:{:?}", stamp.len, stamp.modified)
    }
}
pub fn database_identity(root: &Path) -> Result<String, String> {
    inspect_file(&root.join(DATABASE_NAME), Limits::default())?
        .as_ref()
        .map(stamp_identity)
        .ok_or_else(|| "OpenCode database is missing".into())
}
