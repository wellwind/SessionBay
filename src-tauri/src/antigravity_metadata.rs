//! Experimental, read-only Antigravity CLI metadata import.
//!
//! The schema is observed community implementation evidence, not a Google contract:
//! https://github.com/lefos13/paseo-plugin-antigravity-cli/blob/9732a84dac308717004b8e70d0be592eaa8052ea/server/sessions.ts
//! SQLite never receives a source path. Even read-only SQLite connections can create
//! sidecars, so only validated, private copies of the database and WAL are opened.
use chrono::{DateTime, SecondsFormat};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use sha2::{Digest, Sha256};
#[cfg(any(not(windows), test))]
use std::fs;
use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

const DATABASE_NAME: &str = "conversation_summaries.db";
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_METADATA_ROWS: usize = 50_000;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TITLE_BYTES: usize = 16 * 1024;
const MAX_PREVIEW_BYTES: usize = 64 * 1024;
const MAX_WORKSPACES_BYTES: usize = 16 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_WARNINGS: usize = 100;
const MAX_ERROR_BYTES: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationMetadata {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: Option<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MetadataIndex {
    pub records: HashMap<String, ConversationMetadata>,
    pub fingerprint: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy)]
struct Limits {
    file_bytes: u64,
    snapshot_bytes: u64,
    rows: usize,
    output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: MAX_FILE_BYTES,
            snapshot_bytes: MAX_SNAPSHOT_BYTES,
            rows: MAX_METADATA_ROWS,
            output_bytes: MAX_OUTPUT_BYTES,
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
            return Err("Antigravity metadata source must be a regular, non-symlink file".into());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().map_err(|error| {
                format!("Cannot inspect Antigravity metadata modification time: {error}")
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
pub fn read_metadata(root: &Path, cancel: &AtomicBool) -> Result<MetadataIndex, String> {
    if !cfg!(any(unix, windows)) {
        return Err("Safe Antigravity metadata snapshots are unsupported on this platform".into());
    }
    read_metadata_inner(root, cancel, Limits::default(), &mut |_| {}).map_err(bound_error)
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
    hook: &mut dyn FnMut(SnapshotStage),
) -> Result<MetadataIndex, String> {
    check_cancel(cancel)?;
    let sources = inspect_sources(root, limits)?;
    let Some(database_stamp) = sources.database.as_ref() else {
        if sources.wal.is_some() || sources.journal.is_some() {
            return Err("Antigravity metadata database is missing but sidecars exist; snapshot is uncertain".into());
        }
        hook(SnapshotStage::MissingChecked);
        check_cancel(cancel)?;
        ensure_sources(root, &sources, limits)?;
        return Ok(MetadataIndex {
            records: HashMap::new(),
            fingerprint: format!("{:x}", Sha256::digest(b"antigravity-metadata-v1:missing")),
            warnings: vec!["Antigravity conversation_summaries.db is missing; native titles and workspace metadata are unavailable".into()],
        });
    };

    let temporary = tempfile::Builder::new()
        .prefix("sessionbay-antigravity-metadata-")
        .tempdir()
        .map_err(|error| format!("Cannot create private Antigravity metadata snapshot: {error}"))?;
    let database_path = root.join(DATABASE_NAME);
    let database_copy = temporary.path().join(DATABASE_NAME);
    let database_hash = copy_and_hash(&database_path, &database_copy, database_stamp, cancel)?;
    let wal_hash = match sources.wal.as_ref() {
        Some(stamp) => Some(copy_and_hash(
            &sidecar(root, "wal"),
            &sidecar(temporary.path(), "wal"),
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
    verify_snapshot_sources(
        root,
        &sources,
        [
            &database_hash,
            wal_hash.as_deref().unwrap_or(""),
            journal_hash.as_deref().unwrap_or(""),
        ],
        limits,
        cancel,
    )?;

    let snapshot_warning =
        validate_sqlite_files(&database_copy, sources.wal.is_some(), limits, cancel)?;
    check_cancel(cancel)?;
    let mut index = read_copy(&database_copy, limits, cancel)?;
    if let Some(warning) = snapshot_warning {
        index.warnings.insert(0, warning.into());
    }
    hook(SnapshotStage::Parsed);
    // A result based on a source that changed during parsing is not publishable.
    verify_snapshot_sources(
        root,
        &sources,
        [
            &database_hash,
            wal_hash.as_deref().unwrap_or(""),
            journal_hash.as_deref().unwrap_or(""),
        ],
        limits,
        cancel,
    )?;
    let mut fingerprint = Sha256::new();
    fingerprint.update(b"antigravity-metadata-v1\0");
    for hash in [
        Some(database_hash.as_str()),
        wal_hash.as_deref(),
        journal_hash.as_deref(),
    ] {
        match hash {
            Some(hash) => {
                fingerprint.update(b"present:");
                fingerprint.update(hash.as_bytes());
            }
            None => fingerprint.update(b"missing"),
        }
        fingerprint.update([0]);
    }
    index.fingerprint = format!("{:x}", fingerprint.finalize());
    Ok(index)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("Antigravity metadata read cancelled".into())
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
                return Err("Antigravity metadata file exceeds the snapshot byte limit".into());
            }
            Ok(Some(stamp))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Cannot inspect Antigravity metadata source: {error}"
        )),
    }
}

fn inspect_sources(root: &Path, limits: Limits) -> Result<Sources, String> {
    let sources = Sources {
        database: inspect_file(&root.join(DATABASE_NAME), limits)?,
        wal: inspect_file(&sidecar(root, "wal"), limits)?,
        journal: inspect_file(&sidecar(root, "journal"), limits)?,
    };
    if sources.journal.as_ref().is_some_and(|stamp| stamp.len != 0) {
        return Err("Antigravity metadata has a nonempty rollback journal; a hot or uncertain journal cannot be safely read".into());
    }
    let total = [&sources.database, &sources.wal, &sources.journal]
        .into_iter()
        .flatten()
        .try_fold(0_u64, |sum, stamp| sum.checked_add(stamp.len))
        .ok_or_else(|| "Antigravity metadata snapshot size overflow".to_string())?;
    if total > limits.snapshot_bytes {
        return Err("Antigravity metadata exceeds the total snapshot byte limit".into());
    }
    Ok(sources)
}

fn ensure_sources(root: &Path, expected: &Sources, limits: Limits) -> Result<(), String> {
    if inspect_sources(root, limits)? != *expected {
        return Err(
            "Antigravity metadata changed while reading; retry after the writer settles".into(),
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
        let file = options.open(path).map_err(|error| {
            format!("Cannot open Antigravity metadata source read-only: {error}")
        })?;
        file
    };
    #[cfg(windows)]
    let file = crate::windows_fs::open_regular_readonly_nofollow(path)
        .map_err(|error| format!("Cannot open Antigravity metadata source read-only: {error}"))?;
    verify_file_identity(path, &file, expected)?;
    Ok(file)
}

#[cfg(windows)]
fn windows_stamp(file: &File) -> Result<Stamp, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect Antigravity source: {error}"))?;
    let identity = crate::windows_fs::identity_from_file(file)
        .map_err(|error| format!("Cannot verify Antigravity source identity: {error}"))?;
    Stamp::from_metadata(&metadata, identity)
}

fn verify_file_identity(path: &Path, file: &File, expected: &Stamp) -> Result<(), String> {
    #[cfg(not(windows))]
    let (descriptor, pathname) = {
        let descriptor = file
            .metadata()
            .map_err(|error| format!("Cannot inspect open Antigravity metadata source: {error}"))?;
        let pathname = fs::symlink_metadata(path).map_err(|error| {
            format!("Antigravity metadata source changed or disappeared: {error}")
        })?;
        (
            Stamp::from_metadata(&descriptor)?,
            Stamp::from_metadata(&pathname)?,
        )
    };
    #[cfg(windows)]
    let (descriptor, pathname) = {
        let pathname =
            crate::windows_fs::open_regular_readonly_nofollow(path).map_err(|error| {
                format!("Antigravity metadata source changed or disappeared: {error}")
            })?;
        (windows_stamp(file)?, windows_stamp(&pathname)?)
    };
    if descriptor != *expected || pathname != *expected {
        return Err(
            "Antigravity metadata source identity, size, or timestamps changed while reading"
                .into(),
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
        source.read_exact(&mut buffer[..count]).map_err(|error| {
            format!("Antigravity metadata could not be read completely: {error}")
        })?;
        hash.update(&buffer[..count]);
        if let Some(output) = destination.as_mut() {
            output.write_all(&buffer[..count]).map_err(|error| {
                format!("Cannot write private Antigravity metadata snapshot: {error}")
            })?;
        }
        remaining -= count as u64;
    }
    check_cancel(cancel)?;
    let mut extra = [0_u8; 1];
    if source
        .read(&mut extra)
        .map_err(|error| format!("Cannot finish Antigravity metadata source read: {error}"))?
        != 0
    {
        return Err("Antigravity metadata grew while reading".into());
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
        .map_err(|error| format!("Cannot create private Antigravity metadata copy: {error}"))?;
    stream_source(path, expected, cancel, Some(&mut copy))
}

fn verify_snapshot_sources(
    root: &Path,
    expected: &Sources,
    hashes: [&str; 3],
    limits: Limits,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancel)?;
    ensure_sources(root, expected, limits)?;
    for ((path, stamp), expected_hash) in [
        (root.join(DATABASE_NAME), &expected.database),
        (sidecar(root, "wal"), &expected.wal),
        (sidecar(root, "journal"), &expected.journal),
    ]
    .into_iter()
    .zip(hashes)
    {
        if let Some(stamp) = stamp {
            if hash_source(&path, stamp, cancel)? != expected_hash {
                return Err("Antigravity metadata content changed while reading".into());
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
        .map_err(|error| format!("Cannot open private Antigravity metadata copy: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 100];
    file.read_exact(&mut header)
        .map_err(|_| "Antigravity metadata database has an incomplete SQLite header".to_string())?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err("Antigravity metadata database is not a supported SQLite database".into());
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
        return Err("Antigravity metadata database has an invalid SQLite page layout".into());
    }
    if header[24..28] == header[92..96]
        && u64::from(be32(&header[28..32])) * u64::from(page_size) > limits.file_bytes
    {
        return Err("Antigravity metadata logical database size exceeds the byte limit".into());
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
        return Err("Antigravity metadata WAL is incomplete; refusing a partial snapshot".into());
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
        return Err("Antigravity metadata WAL has an unsupported or mismatched header".into());
    }
    let big_endian = magic == 0x377f0683;
    let mut state = [0_u32; 2];
    checksum(&wal_header[..24], big_endian, &mut state);
    if state != [be32(&wal_header[24..28]), be32(&wal_header[28..32])] {
        return Err("Antigravity metadata WAL header checksum is invalid".into());
    }
    let mut frame = vec![0_u8; frame_size as usize];
    let mut stale_tail = false;
    let mut last_committed_end = 32;
    for index in 0..(wal_length - 32) / frame_size {
        check_cancel(cancel)?;
        wal.read_exact(&mut frame)
            .map_err(|error| error.to_string())?;
        if be32(&frame[..4]) == 0 {
            return Err("Antigravity metadata WAL contains an invalid frame page number".into());
        }
        if frame[8..16] != wal_header[16..24] {
            // Reset increments salt-1. Require a previous generation, rather
            // than treating a changed salt-2 alone as harmless historical data.
            let age = be32(&wal_header[16..20]).wrapping_sub(be32(&frame[8..12]));
            if age == 0 || age > i32::MAX as u32 {
                return Err(
                    "Antigravity metadata WAL contains an uncertain generation mismatch".into(),
                );
            }
            stale_tail = true;
            continue;
        }
        if stale_tail {
            return Err("Antigravity metadata WAL has current frames after stale frames; refusing an uncertain snapshot".into());
        }
        if [be32(&frame[..4]), be32(&frame[4..8])]
            .iter()
            .any(|pages| u64::from(*pages) * u64::from(page_size) > limits.file_bytes)
        {
            return Err("Antigravity metadata WAL exceeds the logical database byte limit".into());
        }
        checksum(&frame[..8], big_endian, &mut state);
        checksum(&frame[24..], big_endian, &mut state);
        if state != [be32(&frame[16..20]), be32(&frame[20..24])] {
            return Err(
                "Antigravity metadata WAL frame checksum is invalid; refusing a partial snapshot"
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
            .map_err(|error| {
                format!("Cannot trim the private Antigravity WAL snapshot: {error}")
            })?;
        return Ok(Some("Antigravity metadata WAL retained previous-generation frames; the private snapshot was limited to its last validated commit"));
    }
    Ok(None)
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("Cannot read Antigravity metadata snapshot: {error}")
}

fn read_copy(
    database: &Path,
    limits: Limits,
    cancel: &AtomicBool,
) -> Result<MetadataIndex, String> {
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql_error)?;
    with_sqlite_cancellation(&connection, cancel, || {
        read_connection(&connection, limits, cancel)
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

fn read_connection(
    connection: &Connection,
    limits: Limits,
    cancel: &AtomicBool,
) -> Result<MetadataIndex, String> {
    connection
        .execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON;",
        )
        .map_err(sql_error)?;
    check_cancel(cancel)?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(sql_error)?;
    if integrity != "ok" {
        return Err("Antigravity metadata snapshot failed SQLite integrity checking".into());
    }
    check_cancel(cancel)?;
    let table: Option<(String, i64)> = {
        use rusqlite::OptionalExtension;
        connection
            .query_row(
                "SELECT type, rootpage FROM sqlite_schema WHERE name = 'conversation_summaries'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_error)?
    };
    if !matches!(table, Some((kind, page)) if kind == "table" && page > 0) {
        return Err("Unsupported Antigravity metadata schema: conversation_summaries must be an ordinary table".into());
    }
    let mut columns = HashSet::new();
    let mut statement = connection
        .prepare("PRAGMA table_xinfo(conversation_summaries)")
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut column_count = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancel(cancel)?;
        column_count += 1;
        if column_count > 128 {
            return Err("Unsupported Antigravity metadata schema: too many columns".into());
        }
        let hidden: i64 = row.get(6).map_err(sql_error)?;
        if hidden == 0 {
            let name = text_field(row.get_ref(1).map_err(sql_error)?, "column name", 256)?
                .ok_or_else(|| {
                    "Unsupported Antigravity metadata schema: missing column name".to_string()
                })?;
            columns.insert(name.to_owned());
        }
    }
    for required in [
        "conversation_id",
        "title",
        "preview",
        "last_modified_time",
        "workspace_uris",
        "parent_conversation_id",
    ] {
        if !columns.contains(required) {
            return Err(format!(
                "Unsupported Antigravity metadata schema: missing ordinary column {required}"
            ));
        }
    }
    drop(rows);
    drop(statement);
    let mut statement = connection
        .prepare("SELECT conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id FROM conversation_summaries LIMIT ?1")
        .map_err(sql_error)?;
    let row_limit = i64::try_from(limits.rows)
        .ok()
        .and_then(|limit| limit.checked_add(1))
        .ok_or_else(|| "Invalid Antigravity metadata row limit".to_string())?;
    let mut rows = statement.query([row_limit]).map_err(sql_error)?;
    let mut index = MetadataIndex {
        records: HashMap::new(),
        fingerprint: String::new(),
        warnings: vec![],
    };
    let mut output_bytes = 0_usize;
    let mut omitted_warnings = 0_usize;
    let mut seen_ids = HashSet::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancel(cancel)?;
        if index.records.len() >= limits.rows {
            return Err(
                "Antigravity metadata exceeds the row limit; refusing a partial index".into(),
            );
        }
        let id_text = text_field(row.get_ref(0).map_err(sql_error)?, "conversation_id", 36)?
            .ok_or_else(|| "Antigravity metadata conversation_id is missing".to_string())?;
        let id = valid_uuid(id_text)?;
        if !seen_ids.insert(id.to_ascii_lowercase()) {
            return Err("Antigravity metadata contains duplicate conversation UUIDs".into());
        }
        let title = text_field(row.get_ref(1).map_err(sql_error)?, "title", MAX_TITLE_BYTES)?
            .filter(|title| !title.trim().is_empty())
            .map(str::to_owned);
        // Validate the observed preview column, but never use it as a native title.
        text_field(
            row.get_ref(2).map_err(sql_error)?,
            "preview",
            MAX_PREVIEW_BYTES,
        )?;
        let timestamp = text_field(
            row.get_ref(3).map_err(sql_error)?,
            "last_modified_time",
            128,
        )?;
        let updated_at = parse_timestamp(timestamp)?;
        let workspaces = text_field(
            row.get_ref(4).map_err(sql_error)?,
            "workspace_uris",
            MAX_WORKSPACES_BYTES,
        )?;
        let (cwd, workspace_warning) = parse_workspaces(workspaces)?;
        let parent = text_field(
            row.get_ref(5).map_err(sql_error)?,
            "parent_conversation_id",
            36,
        )?;
        let parent_id = parent
            .filter(|value| !value.is_empty())
            .map(valid_uuid)
            .transpose()?;
        if let Some(warning) = workspace_warning {
            if index.warnings.len() < MAX_WARNINGS {
                index
                    .warnings
                    .push(format!("Antigravity conversation {id}: {warning}"));
            } else {
                omitted_warnings += 1;
            }
        }
        output_bytes = output_bytes
            .checked_add(
                id.len() * 2
                    + title.as_ref().map_or(0, String::len)
                    + cwd.as_ref().map_or(0, String::len)
                    + updated_at.as_ref().map_or(0, String::len)
                    + parent_id.as_ref().map_or(0, String::len),
            )
            .ok_or_else(|| "Antigravity metadata output size overflow".to_string())?;
        if output_bytes > limits.output_bytes {
            return Err(
                "Antigravity metadata exceeds the output byte limit; refusing a partial index"
                    .into(),
            );
        }
        let record = ConversationMetadata {
            id: id.clone(),
            title,
            cwd,
            updated_at,
            parent_id,
        };
        index.records.insert(id, record);
    }
    check_cancel(cancel)?;
    if omitted_warnings > 0 {
        index.warnings.push(format!(
            "{omitted_warnings} additional conversations have unavailable workspace mappings"
        ));
    }
    Ok(index)
}

fn text_field<'a>(
    value: ValueRef<'a>,
    column: &str,
    limit: usize,
) -> Result<Option<&'a str>, String> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) => {
            if bytes.len() > limit {
                return Err(format!(
                    "Antigravity metadata {column} exceeds its byte limit"
                ));
            }
            let text = std::str::from_utf8(bytes)
                .map_err(|_| format!("Antigravity metadata {column} contains invalid UTF-8"))?;
            if text.contains('\0') {
                return Err(format!(
                    "Antigravity metadata {column} contains a NUL character"
                ));
            }
            Ok(Some(text))
        }
        _ => Err(format!(
            "Antigravity metadata {column} must be text or null"
        )),
    }
}

fn valid_uuid(value: &str) -> Result<String, String> {
    if value.len() != 36
        || [8, 13, 18, 23]
            .iter()
            .any(|index| value.as_bytes()[*index] != b'-')
    {
        return Err("Antigravity metadata contains an invalid conversation UUID".into());
    }
    uuid::Uuid::parse_str(value)
        .map(|_| value.to_owned())
        .map_err(|_| "Antigravity metadata contains an invalid conversation UUID".into())
}

fn parse_timestamp(timestamp: Option<&str>) -> Result<Option<String>, String> {
    let Some(timestamp) = timestamp.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let mut normalized = timestamp.to_owned();
    if normalized.as_bytes().get(10) == Some(&b' ') {
        normalized.replace_range(10..11, "T");
    }
    DateTime::parse_from_rfc3339(&normalized)
        .map(|timestamp| {
            Some(
                timestamp
                    .to_utc()
                    .to_rfc3339_opts(SecondsFormat::AutoSi, true),
            )
        })
        .map_err(|_| "Antigravity metadata contains an invalid last_modified_time".into())
}

fn parse_workspaces(value: Option<&str>) -> Result<(Option<String>, Option<&'static str>), String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok((None, None));
    };
    let uris: Vec<String> = serde_json::from_str(value).map_err(|_| {
        "Antigravity metadata workspace_uris must be a JSON array of strings".to_string()
    })?;
    let mut paths = HashSet::new();
    let mut invalid = false;
    for uri in uris {
        if let Some(path) = local_file_uri(&uri) {
            paths.insert(path);
        } else {
            invalid = true;
        }
    }
    if invalid {
        return Ok((
            None,
            Some("unsupported workspace URI; project mapping is unavailable"),
        ));
    }
    if paths.len() > 1 {
        return Ok((
            None,
            Some("multiple workspaces; project mapping is ambiguous"),
        ));
    }
    Ok((paths.into_iter().next(), None))
}

fn local_file_uri(uri: &str) -> Option<String> {
    // No authority, query, fragment, credentials, relative paths, or remote hosts.
    let encoded = uri.strip_prefix("file://")?;
    if !encoded.starts_with('/') || encoded.starts_with("//") || encoded.contains(['?', '#', '\\'])
    {
        return None;
    }
    let mut decoded = Vec::with_capacity(encoded.len());
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = (*bytes.get(index + 1)? as char).to_digit(16)?;
            let low = (*bytes.get(index + 2)? as char).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(decoded).ok()?;
    #[cfg(windows)]
    let path = {
        let bytes = path.as_bytes();
        if bytes.len() < 4
            || bytes[0] != b'/'
            || !bytes[1].is_ascii_alphabetic()
            || bytes[2] != b':'
            || bytes[3] != b'/'
            || path[3..].contains([':', '*', '?', '"', '<', '>', '|'])
        {
            return None;
        }
        // file:///C:/... is a local absolute drive path. Keep forward slashes:
        // Rust/Windows accepts them and URI text is never passed to a shell.
        let native = path[1..].to_owned();
        if !crate::windows_fs::valid_filesystem_path(Path::new(&native)) {
            return None;
        }
        native
    };
    if path.len() > MAX_PATH_BYTES
        || path.starts_with("//")
        || path
            .chars()
            .any(|value| value.is_control() || value == '\\')
        || !Path::new(&path).is_absolute()
        || Path::new(&path)
            .components()
            .any(|value| matches!(value, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const ID: &str = "11111111-2222-4333-8444-555555555555";
    const CHILD_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const SCHEMA: &str = "CREATE TABLE conversation_summaries (
        conversation_id TEXT, title TEXT, preview TEXT, last_modified_time TEXT,
        workspace_uris TEXT, parent_conversation_id TEXT
    );";

    fn cancelled() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn insert(connection: &Connection, id: &str, workspaces: &str, parent: &str) {
        connection
            .execute(
                "INSERT INTO conversation_summaries VALUES (?1, 'Native title', 'A synthetic preview', '2026-09-23 13:31:32.28859+00:00', ?2, ?3)",
                [id, workspaces, parent],
            )
            .unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        insert(
            &connection,
            ID,
            r#"["file:///tmp/Synthetic%20Project"]"#,
            "",
        );
        connection.close().unwrap();
        root
    }

    fn change(root: &Path, sql: &str) {
        let connection = Connection::open(root.join(DATABASE_NAME)).unwrap();
        connection.execute_batch(sql).unwrap();
        connection.close().unwrap();
    }

    // Only generated, harmless SQLite data is used. Copying the writer's files
    // here models a stable native WAL without opening the test source in SQLite.
    fn wal_fixture() -> tempfile::TempDir {
        let writer_root = tempfile::tempdir().unwrap();
        let writer = Connection::open(writer_root.path().join(DATABASE_NAME)).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        writer.execute_batch(SCHEMA).unwrap();
        insert(&writer, ID, r#"["file:///tmp/Wal%20Project"]"#, "");
        let source = tempfile::tempdir().unwrap();
        fs::copy(
            writer_root.path().join(DATABASE_NAME),
            source.path().join(DATABASE_NAME),
        )
        .unwrap();
        fs::copy(
            sidecar(writer_root.path(), "wal"),
            sidecar(source.path(), "wal"),
        )
        .unwrap();
        source
    }

    fn reused_wal_fixture() -> tempfile::TempDir {
        let writer_root = tempfile::tempdir().unwrap();
        let writer = Connection::open(writer_root.path().join(DATABASE_NAME)).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        writer.execute_batch(SCHEMA).unwrap();
        insert(&writer, ID, "[]", "");
        writer.execute_batch("PRAGMA wal_checkpoint(RESTART); UPDATE conversation_summaries SET title='Latest committed title';").unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::copy(
            writer_root.path().join(DATABASE_NAME),
            source.path().join(DATABASE_NAME),
        )
        .unwrap();
        fs::copy(
            sidecar(writer_root.path(), "wal"),
            sidecar(source.path(), "wal"),
        )
        .unwrap();
        let wal = fs::read(sidecar(source.path(), "wal")).unwrap();
        let frame_size = 24 + be32(&wal[8..12]) as usize;
        assert!(wal.len() >= 32 + frame_size * 2);
        assert_ne!(wal[16..24], wal[32 + frame_size + 8..32 + frame_size + 16]);
        source
    }

    fn rewrite_wal_checksums(wal: &mut [u8], big_endian: bool, frame_count: usize) {
        let magic: u32 = if big_endian { 0x377f0683 } else { 0x377f0682 };
        wal[..4].copy_from_slice(&magic.to_be_bytes());
        let frame_size = 24 + be32(&wal[8..12]) as usize;
        let mut state = [0_u32; 2];
        checksum(&wal[..24], big_endian, &mut state);
        wal[24..28].copy_from_slice(&state[0].to_be_bytes());
        wal[28..32].copy_from_slice(&state[1].to_be_bytes());
        for index in 0..frame_count {
            let frame = &mut wal[32 + index * frame_size..32 + (index + 1) * frame_size];
            checksum(&frame[..8], big_endian, &mut state);
            checksum(&frame[24..], big_endian, &mut state);
            frame[16..20].copy_from_slice(&state[0].to_be_bytes());
            frame[20..24].copy_from_slice(&state[1].to_be_bytes());
        }
    }

    fn inventory(root: &Path) -> BTreeMap<String, (Stamp, Vec<u8>)> {
        fs::read_dir(root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let stamp = Stamp::from_metadata(&entry.metadata().unwrap()).unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    (stamp, fs::read(entry.path()).unwrap()),
                )
            })
            .collect()
    }

    #[test]
    fn reads_native_metadata_and_preserves_all_source_bytes_and_sidecars() {
        let root = fixture();
        fs::write(
            sidecar(root.path(), "shm"),
            b"synthetic existing sidecar, never opened",
        )
        .unwrap();
        let before = inventory(root.path());
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records.len(), 1);
        let row = &result.records[ID];
        assert_eq!(row.id, ID);
        assert_eq!(row.title.as_deref(), Some("Native title"));
        assert_eq!(row.cwd.as_deref(), Some("/tmp/Synthetic Project"));
        assert_eq!(
            row.updated_at.as_deref(),
            Some("2026-09-23T13:31:32.288590Z")
        );
        assert_eq!(row.parent_id, None);
        assert!(result.warnings.is_empty());
        assert_eq!(before, inventory(root.path()));
        assert_eq!(
            result.fingerprint,
            read_metadata(root.path(), &cancelled())
                .unwrap()
                .fingerprint
        );
    }

    #[test]
    fn reads_committed_wal_without_creating_original_shm_or_checkpointing() {
        let root = wal_fixture();
        assert!(!sidecar(root.path(), "shm").exists());
        let before = inventory(root.path());
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records[ID].cwd.as_deref(), Some("/tmp/Wal Project"));
        assert_eq!(before, inventory(root.path()));
        assert!(!sidecar(root.path(), "shm").exists());
    }

    #[test]
    fn reads_reused_wal_last_commit_with_warning_and_unchanged_source() {
        let root = reused_wal_fixture();
        let before = inventory(root.path());
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(
            result.records[ID].title.as_deref(),
            Some("Latest committed title")
        );
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("previous-generation"));
        assert_eq!(before, inventory(root.path()));
        assert!(!sidecar(root.path(), "shm").exists());
    }

    #[test]
    fn reused_wal_excludes_valid_but_uncommitted_current_frames() {
        let root = reused_wal_fixture();
        let path = sidecar(root.path(), "wal");
        let mut wal = fs::read(&path).unwrap();
        wal[36..40].copy_from_slice(&0_u32.to_be_bytes());
        let big_endian = be32(&wal[..4]) == 0x377f0683;
        rewrite_wal_checksums(&mut wal, big_endian, 1);
        fs::write(&path, wal).unwrap();
        let before = inventory(root.path());
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records[ID].title.as_deref(), Some("Native title"));
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(before, inventory(root.path()));
    }

    #[test]
    fn reused_wal_does_not_hide_incomplete_corrupt_or_uncertain_current_frames() {
        for corruption in 0..5 {
            let root = reused_wal_fixture();
            let path = sidecar(root.path(), "wal");
            let mut wal = fs::read(&path).unwrap();
            let frame_size = 24 + be32(&wal[8..12]) as usize;
            match corruption {
                0 => {
                    wal.pop();
                }
                1 => {
                    wal[32 + 24] ^= 1;
                }
                2 => {
                    wal[32 + 12] ^= 1;
                }
                3 => {
                    let current_frame = wal[32..32 + frame_size].to_vec();
                    wal.extend(current_frame);
                }
                _ => {
                    let future_salt = be32(&wal[16..20]).wrapping_add(1).to_be_bytes();
                    wal[32 + frame_size + 8..32 + frame_size + 12].copy_from_slice(&future_salt);
                }
            }
            fs::write(path, wal).unwrap();
            let before = inventory(root.path());
            assert!(
                read_metadata(root.path(), &cancelled()).is_err(),
                "accepted corruption {corruption}"
            );
            assert_eq!(before, inventory(root.path()));
        }
    }

    #[test]
    fn validates_both_sqlite_wal_checksum_byte_orders() {
        let root = wal_fixture();
        let path = sidecar(root.path(), "wal");
        let mut wal = fs::read(&path).unwrap();
        let frame_size = 24 + be32(&wal[8..12]) as usize;
        let frame_count = (wal.len() - 32) / frame_size;
        for big_endian in [true, false] {
            rewrite_wal_checksums(&mut wal, big_endian, frame_count);
            fs::write(&path, &wal).unwrap();
            assert_eq!(
                read_metadata(root.path(), &cancelled())
                    .unwrap()
                    .records
                    .len(),
                1
            );
        }
    }

    #[test]
    fn rejects_oversized_logical_database_even_when_physical_files_are_small() {
        let root = fixture();
        let path = root.path().join(DATABASE_NAME);
        let mut bytes = fs::read(&path).unwrap();
        bytes[28..32].copy_from_slice(&u32::MAX.to_be_bytes());
        let change_counter = bytes[24..28].to_vec();
        bytes[92..96].copy_from_slice(&change_counter);
        fs::write(path, bytes).unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("logical database size"));
        let root = wal_fixture();
        let path = sidecar(root.path(), "wal");
        let mut wal = fs::read(&path).unwrap();
        wal[36..40].copy_from_slice(&u32::MAX.to_be_bytes());
        fs::write(path, wal).unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("logical database byte limit"));
    }

    #[test]
    fn includes_children_preserves_uuid_case_and_normalizes_timestamp() {
        let root = fixture();
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        insert(&connection, &CHILD_ID.to_uppercase(), "[]", ID);
        connection.execute("UPDATE conversation_summaries SET last_modified_time='2026-10-01T09:30:00+02:00' WHERE conversation_id=?1", [&CHILD_ID.to_uppercase()]).unwrap();
        connection.close().unwrap();
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(
            result.records[&CHILD_ID.to_uppercase()].id,
            CHILD_ID.to_uppercase()
        );
        assert_eq!(
            result.records[&CHILD_ID.to_uppercase()]
                .parent_id
                .as_deref(),
            Some(ID)
        );
        assert_eq!(
            result.records[&CHILD_ID.to_uppercase()]
                .updated_at
                .as_deref(),
            Some("2026-10-01T07:30:00Z")
        );
        assert_eq!(result.records[&CHILD_ID.to_uppercase()].cwd, None);
        assert_eq!(
            valid_uuid(&CHILD_ID.to_uppercase()).unwrap(),
            CHILD_ID.to_uppercase()
        );
    }

    #[test]
    fn missing_is_explicit_stable_and_does_not_create_a_database() {
        let root = tempfile::tempdir().unwrap();
        let first = read_metadata(root.path(), &cancelled()).unwrap();
        let second = read_metadata(root.path(), &cancelled()).unwrap();
        assert!(first.records.is_empty());
        assert_eq!(first.warnings.len(), 1);
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        fs::write(sidecar(root.path(), "wal"), []).unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("sidecars exist"));
    }

    #[test]
    fn rejects_database_appearance_during_missing_check() {
        let root = tempfile::tempdir().unwrap();
        let result =
            read_metadata_inner(root.path(), &cancelled(), Limits::default(), &mut |stage| {
                if matches!(stage, SnapshotStage::MissingChecked) {
                    fs::write(root.path().join(DATABASE_NAME), [0_u8; 512]).unwrap();
                }
            });
        assert!(result.unwrap_err().contains("changed"));
    }

    #[test]
    fn rejects_unknown_schema_views_generated_fields_and_bad_database() {
        for schema in [
            "CREATE TABLE other (id TEXT);",
            "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT);",
            "CREATE VIEW conversation_summaries AS SELECT 1 AS conversation_id;",
            "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT GENERATED ALWAYS AS ('x') VIRTUAL, preview TEXT, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT);",
        ] {
            let root = tempfile::tempdir().unwrap();
            let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
            connection.execute_batch(schema).unwrap();
            connection.close().unwrap();
            assert!(read_metadata(root.path(), &cancelled()).unwrap_err().contains("schema"));
        }
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(DATABASE_NAME), [0_u8; 512]).unwrap();
        assert!(read_metadata(root.path(), &cancelled()).is_err());
    }

    #[test]
    fn rejects_malformed_rows_instead_of_publishing_a_partial_index() {
        for sql in [
            "UPDATE conversation_summaries SET conversation_id='not-a-uuid'",
            "UPDATE conversation_summaries SET conversation_id=NULL",
            "UPDATE conversation_summaries SET parent_conversation_id='../parent'",
            "UPDATE conversation_summaries SET title=X'6162'",
            "UPDATE conversation_summaries SET title=CAST(X'ff' AS TEXT)",
            "UPDATE conversation_summaries SET title=CAST(X'610062' AS TEXT)",
            "UPDATE conversation_summaries SET workspace_uris='broken-json'",
            "UPDATE conversation_summaries SET workspace_uris='[23]'",
            "UPDATE conversation_summaries SET last_modified_time='2026-99-23 13:00:00+00:00'",
        ] {
            let root = fixture();
            change(root.path(), sql);
            assert!(
                read_metadata(root.path(), &cancelled()).is_err(),
                "accepted {sql}"
            );
        }
    }

    #[test]
    fn permits_optional_null_metadata_without_inventing_titles_or_workspace() {
        let root = fixture();
        change(root.path(), "UPDATE conversation_summaries SET title=NULL, workspace_uris=NULL, last_modified_time=NULL, parent_conversation_id=NULL");
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records[ID].title, None);
        assert_eq!(result.records[ID].cwd, None);
        assert_eq!(result.records[ID].updated_at, None);
    }

    #[test]
    fn rejects_duplicates_including_uuid_case_variations() {
        let root = fixture();
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        insert(&connection, CHILD_ID, "[]", "");
        insert(&connection, &CHILD_ID.to_uppercase(), "[]", "");
        connection.close().unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("duplicate"));
    }

    #[test]
    fn workspace_uri_validation_is_local_absolute_and_conservative() {
        for invalid in [
            "https://example.org/tmp/project",
            "file://server/tmp/project",
            "file://localhost/tmp/project",
            "file:relative",
            "file:///tmp/a?query",
            "file:///tmp/a#fragment",
            "file:////server/share",
            "file:///%2fserver/share",
            "file:///tmp/%00x",
            "file:///tmp/%0ax",
            "file:///tmp/%FF",
            "file:///tmp/%2e%2e/elsewhere",
            "file:///tmp/../elsewhere",
            "file:///tmp/%",
            "file:///tmp/%2",
            "file:///tmp/%zz",
            "file:///tmp/a\\b",
            "file:///tmp/a%5cb",
        ] {
            assert!(local_file_uri(invalid).is_none(), "accepted {invalid}");
        }
        assert_eq!(
            local_file_uri("file:///tmp/%E5%B7%A5%E4%BD%9C%20a%23b%3Fc").as_deref(),
            Some("/tmp/工作 a#b?c")
        );
        assert_eq!(
            local_file_uri("file:///tmp/a+b").as_deref(),
            Some("/tmp/a+b")
        );
        let (path, warning) =
            parse_workspaces(Some(r#"["file:///tmp/a", "file:///tmp/b"]"#)).unwrap();
        assert_eq!(path, None);
        assert!(warning.unwrap().contains("multiple"));
        let (path, warning) =
            parse_workspaces(Some(r#"["file:///tmp/a", "file://remote/tmp/b"]"#)).unwrap();
        assert_eq!(path, None);
        assert!(warning.is_some());
        let (path, warning) =
            parse_workspaces(Some(r#"["file:///tmp/a", "file:///tmp/a"]"#)).unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/a"));
        assert_eq!(warning, None);
    }

    #[test]
    fn ambiguous_workspace_rows_report_warnings() {
        let root = fixture();
        change(
            root.path(),
            r#"UPDATE conversation_summaries SET workspace_uris='["file:///tmp/a", "file:///tmp/b"]'"#,
        );
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records[ID].cwd, None);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn rejects_hot_or_uncertain_rollback_journals_without_recovery() {
        let root = fixture();
        fs::write(
            sidecar(root.path(), "journal"),
            b"synthetic uncertain rollback journal",
        )
        .unwrap();
        let before = inventory(root.path());
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("rollback journal"));
        assert_eq!(before, inventory(root.path()));
        fs::write(sidecar(root.path(), "journal"), []).unwrap();
        let before = inventory(root.path());
        assert_eq!(
            read_metadata(root.path(), &cancelled())
                .unwrap()
                .records
                .len(),
            1
        );
        assert_eq!(before, inventory(root.path()));
    }

    #[test]
    fn rejects_incomplete_and_corrupt_wal_instead_of_ignoring_commits() {
        for truncate in [true, false] {
            let root = wal_fixture();
            let path = sidecar(root.path(), "wal");
            let mut bytes = fs::read(&path).unwrap();
            if truncate {
                bytes.pop();
            } else {
                *bytes.last_mut().unwrap() ^= 1;
            }
            fs::write(&path, bytes).unwrap();
            let before = inventory(root.path());
            let error = read_metadata(root.path(), &cancelled()).unwrap_err();
            assert!(error.contains("WAL"));
            assert_eq!(before, inventory(root.path()));
        }
    }

    #[test]
    fn rejects_symlink_sources_and_sidecars() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        symlink(root.path().join(DATABASE_NAME), sidecar(root.path(), "wal")).unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("non-symlink"));
        fs::remove_file(sidecar(root.path(), "wal")).unwrap();
        let linked = tempfile::tempdir().unwrap();
        symlink(
            root.path().join(DATABASE_NAME),
            linked.path().join(DATABASE_NAME),
        )
        .unwrap();
        assert!(read_metadata(linked.path(), &cancelled())
            .unwrap_err()
            .contains("non-symlink"));
    }

    #[test]
    fn rejects_file_total_row_output_and_field_size_limits() {
        let root = fixture();
        for limits in [
            Limits {
                file_bytes: 1,
                ..Limits::default()
            },
            Limits {
                snapshot_bytes: 1,
                ..Limits::default()
            },
            Limits {
                rows: 0,
                ..Limits::default()
            },
            Limits {
                output_bytes: 1,
                ..Limits::default()
            },
        ] {
            assert!(
                read_metadata_inner(root.path(), &cancelled(), limits, &mut |_| {})
                    .unwrap_err()
                    .contains("limit")
            );
        }
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        insert(&connection, CHILD_ID, "[]", "");
        connection.close().unwrap();
        assert!(read_metadata_inner(
            root.path(),
            &cancelled(),
            Limits {
                rows: 1,
                ..Limits::default()
            },
            &mut |_| {}
        )
        .unwrap_err()
        .contains("partial index"));
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        connection
            .execute(
                "UPDATE conversation_summaries SET title=?1",
                ["a".repeat(MAX_TITLE_BYTES + 1)],
            )
            .unwrap();
        connection.close().unwrap();
        assert!(read_metadata(root.path(), &cancelled())
            .unwrap_err()
            .contains("title exceeds"));
    }

    #[test]
    fn cancellation_before_and_during_snapshot_is_an_error() {
        let root = fixture();
        let cancel = AtomicBool::new(true);
        assert!(read_metadata(root.path(), &cancel)
            .unwrap_err()
            .contains("cancelled"));
        cancel.store(false, Ordering::Relaxed);
        let result = read_metadata_inner(root.path(), &cancel, Limits::default(), &mut |stage| {
            if matches!(stage, SnapshotStage::Copied) {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[test]
    fn rejects_rewrites_replacements_and_new_wals_during_snapshot() {
        for action in 0..3 {
            let root = fixture();
            let result =
                read_metadata_inner(root.path(), &cancelled(), Limits::default(), &mut |stage| {
                    if !matches!(stage, SnapshotStage::Copied) {
                        return;
                    }
                    let database = root.path().join(DATABASE_NAME);
                    match action {
                        0 => {
                            let modified = fs::metadata(&database).unwrap().modified().unwrap();
                            let mut bytes = fs::read(&database).unwrap();
                            *bytes.last_mut().unwrap() ^= 1;
                            fs::write(&database, bytes).unwrap();
                            File::options()
                                .write(true)
                                .open(database)
                                .unwrap()
                                .set_modified(modified)
                                .unwrap();
                        }
                        1 => {
                            let bytes = fs::read(&database).unwrap();
                            fs::rename(&database, root.path().join("replaced.db")).unwrap();
                            fs::write(database, bytes).unwrap();
                        }
                        _ => {
                            fs::write(sidecar(root.path(), "wal"), []).unwrap();
                        }
                    }
                });
            assert!(
                result.unwrap_err().contains("changed"),
                "accepted action {action}"
            );
        }
    }

    #[test]
    fn validates_full_content_hash_in_addition_to_metadata() {
        let root = fixture();
        let limits = Limits::default();
        let sources = inspect_sources(root.path(), limits).unwrap();
        let database = root.path().join(DATABASE_NAME);
        let original_hash =
            hash_source(&database, sources.database.as_ref().unwrap(), &cancelled()).unwrap();
        let mut bytes = fs::read(&database).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&database, bytes).unwrap();
        let current_sources = inspect_sources(root.path(), limits).unwrap();
        let result = verify_snapshot_sources(
            root.path(),
            &current_sources,
            [&original_hash, "", ""],
            limits,
            &cancelled(),
        );
        assert!(result.unwrap_err().contains("content changed"));
    }

    #[test]
    fn rejects_source_change_after_sqlite_finishes_reading() {
        let root = fixture();
        let result =
            read_metadata_inner(root.path(), &cancelled(), Limits::default(), &mut |stage| {
                if matches!(stage, SnapshotStage::Parsed) {
                    change(
                        root.path(),
                        "UPDATE conversation_summaries SET title='Changed title'",
                    );
                }
            });
        assert!(result.unwrap_err().contains("changed"));
    }

    #[test]
    fn fingerprint_changes_on_metadata_edit() {
        let root = fixture();
        let first = read_metadata(root.path(), &cancelled()).unwrap();
        change(
            root.path(),
            "UPDATE conversation_summaries SET title='Edited title'",
        );
        let second = read_metadata(root.path(), &cancelled()).unwrap();
        assert_ne!(first.fingerprint, second.fingerprint);
        assert_eq!(second.records[ID].title.as_deref(), Some("Edited title"));
    }

    #[test]
    fn cancellation_interrupts_sqlite_work_between_rows() {
        let connection = Connection::open_in_memory().unwrap();
        let cancel = cancelled();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(20));
                cancel.store(true, Ordering::Relaxed);
            });
            let result = with_sqlite_cancellation(&connection, &cancel, || {
                connection.query_row(
                    "WITH RECURSIVE counter(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM counter WHERE n<1000000000) SELECT sum(n) FROM counter",
                    [],
                    |row| row.get::<_, i64>(0),
                ).map_err(sql_error)
            });
            assert!(result.unwrap_err().contains("cancelled"));
        });
    }

    #[test]
    fn warnings_and_multibyte_error_messages_are_bounded() {
        let root = fixture();
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        for _ in 0..MAX_WARNINGS + 5 {
            insert(
                &connection,
                &uuid::Uuid::new_v4().to_string(),
                r#"["file://remote/path"]"#,
                "",
            );
        }
        connection.close().unwrap();
        let result = read_metadata(root.path(), &cancelled()).unwrap();
        assert_eq!(result.records.len(), MAX_WARNINGS + 6);
        assert_eq!(result.warnings.len(), MAX_WARNINGS + 1);
        assert!(result.warnings.last().unwrap().starts_with("5 additional"));
        let error = bound_error("合成錯誤".repeat(MAX_ERROR_BYTES));
        assert!(error.len() <= MAX_ERROR_BYTES);
        assert!(error.ends_with("..."));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::collections::BTreeMap;

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::open(root.path().join(DATABASE_NAME)).unwrap();
        connection.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT);").unwrap();
        connection.execute("INSERT INTO conversation_summaries VALUES (?1, 'Synthetic title', 'Synthetic preview', '2026-10-01T00:00:00Z', ?2, NULL)",
            [ID, r#"["file:///C:/Synthetic%20Project/%E4%B8%AD%E6%96%87"]"#]).unwrap();
        connection.close().unwrap();
        root
    }

    fn inventory(root: &Path) -> BTreeMap<String, (Stamp, Vec<u8>)> {
        fs::read_dir(root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let file =
                    crate::windows_fs::open_regular_readonly_nofollow(&entry.path()).unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    (
                        windows_stamp(&file).unwrap(),
                        fs::read(entry.path()).unwrap(),
                    ),
                )
            })
            .collect()
    }

    #[test]
    fn windows_metadata_snapshot_preserves_source_bytes_identity_and_sidecars() {
        let root = fixture();
        fs::write(sidecar(root.path(), "shm"), "synthetic untouched sidecar").unwrap();
        let before = inventory(root.path());
        let result = read_metadata(root.path(), &AtomicBool::new(false)).unwrap();
        assert_eq!(
            result.records[ID].cwd.as_deref(),
            Some("C:/Synthetic Project/中文")
        );
        assert_eq!(result.records[ID].title.as_deref(), Some("Synthetic title"));
        assert_eq!(before, inventory(root.path()));
        assert_eq!(
            result.fingerprint,
            read_metadata(root.path(), &AtomicBool::new(false))
                .unwrap()
                .fingerprint
        );
    }

    #[test]
    fn windows_local_drive_uri_rejects_network_devices_ads_and_relative_paths() {
        assert_eq!(
            local_file_uri("file:///C:/Space%20and%20%E4%B8%AD%E6%96%87").as_deref(),
            Some("C:/Space and 中文")
        );
        for invalid in [
            "file://server/share/project",
            "file:////server/share",
            "file:///tmp/project",
            "file:///C:relative",
            "file:///C:/../other",
            "file:///C:/%2e%2e/other",
            "file:///C:/project:stream",
            "file:///C:/a%5cb",
            "file:///C:/a%00b",
            "file:///C:/a%3Fb",
            "file:///C:/a?query",
            "file:///C:/a#fragment",
        ] {
            assert!(local_file_uri(invalid).is_none(), "accepted {invalid}");
        }
    }

    #[test]
    fn windows_snapshot_rejects_replacement_with_identical_bytes_and_timestamps() {
        let root = fixture();
        let path = root.path().join(DATABASE_NAME);
        let replacement = root.path().join("replacement.db");
        fs::copy(&path, &replacement).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let result = read_metadata_inner(
            root.path(),
            &AtomicBool::new(false),
            Limits::default(),
            &mut |stage| {
                if matches!(stage, SnapshotStage::Copied) {
                    fs::rename(&path, root.path().join("old.db")).unwrap();
                    fs::rename(&replacement, &path).unwrap();
                }
            },
        );
        assert!(result.unwrap_err().contains("changed"));
    }

    #[test]
    fn windows_missing_and_cancelled_metadata_fail_without_creating_source_files() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_metadata(root.path(), &AtomicBool::new(false))
            .unwrap()
            .records
            .is_empty());
        assert!(read_metadata(root.path(), &AtomicBool::new(true)).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
