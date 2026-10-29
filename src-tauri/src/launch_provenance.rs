//! Minimal backend-issued evidence for fresh, validated direct local launches.
//!
//! This is not a record of launch arguments, environment, executables, or agent
//! history. Call `record` only after the backend has validated a direct route and
//! received the matching fresh runtime from the same broker generation. A
//! broker's explicit `file_input == Some(false)` must still take precedence.
//! Records are immutable. Only validated current-generation records explicitly
//! exited in an authoritative broker list may be pruned. Absent runtimes, other
//! generations, unfamiliar entries and interrupted writes are always preserved.
//! Exhausted or unsafe stores fail closed without changing any running process.

use crate::broker::RuntimeRecord;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const DIRECTORY: &str = "launch-provenance-v1";
const LOCK_FILE: &str = "provenance.lock";
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STORE_FILES: usize = 2048;
const MAX_CWD_BYTES: usize = 8192;
const MAX_CONTEXT_ID_BYTES: usize = 512;

#[cfg(windows)]
use crate::windows_security;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    version: u8,
    generation: String,
    runtime_id: String,
    pane_id: String,
    kind: String,
    cwd: String,
    project_id: Option<String>,
    profile_id: Option<String>,
}

impl Evidence {
    fn from_runtime(generation: &str, record: &RuntimeRecord) -> Result<Self, String> {
        if record.info.state != "running"
            || record.info.exit_code.is_some()
            || record.info.session_id.is_some()
            || record.resume_id.is_some()
        {
            return Err("Launch provenance requires a fresh running runtime.".into());
        }
        let value = Self {
            version: 1,
            generation: generation.to_owned(),
            runtime_id: record.info.id.clone(),
            pane_id: record.info.pane_id.clone(),
            kind: record.kind.clone(),
            cwd: record.info.cwd.clone(),
            project_id: record.project_id.clone(),
            profile_id: record.profile_id.clone(),
        };
        value.validate()?;
        let canonical = fs::canonicalize(&value.cwd).map_err(|e| e.to_string())?;
        if canonical.to_str() != Some(value.cwd.as_str()) || !canonical.is_dir() {
            return Err("Launch provenance requires an exact canonical working directory.".into());
        }
        Ok(value)
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || !canonical_uuid(&self.generation)
            || !canonical_uuid(&self.runtime_id)
            || !canonical_uuid(&self.pane_id)
            || !matches!(self.kind.as_str(), "codex" | "claude" | "grok" | "opencode")
            || self.cwd.len() > MAX_CWD_BYTES
            || !Path::new(&self.cwd).is_absolute()
            || self.cwd.chars().any(char::is_control)
            || [&self.project_id, &self.profile_id].iter().any(|id| {
                id.as_ref().is_some_and(|id| {
                    id.is_empty()
                        || id.len() > MAX_CONTEXT_ID_BYTES
                        || id.chars().any(char::is_control)
                })
            })
        {
            return Err("Invalid launch provenance identity.".into());
        }
        Ok(())
    }
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

pub struct LaunchProvenance {
    directory: PathBuf,
    directory_handle: File,
    // Both locks are necessary: OS file locks do not serialize threads sharing
    // one open file description; the mutex alone does not serialize processes.
    lock: Mutex<File>,
}

impl LaunchProvenance {
    /// Create only when fresh-launch evidence is first needed. The application
    /// configuration directory must already exist; no ancestor is created.
    pub fn open(app_directory: &Path) -> Result<Self, String> {
        let requested = app_directory.join(DIRECTORY);
        private_directory(&requested)?;
        let directory_handle = open_directory(&requested)?;
        let directory = fs::canonicalize(&requested).map_err(|e| e.to_string())?;
        if !same_file(&directory_handle, &open_directory(&directory)?)? {
            return Err("Launch provenance directory changed while opening.".into());
        }
        // Windows: explicit user owner, as for broker and staging locks.
        #[cfg(windows)]
        let lock =
            windows_security::open_lock(&directory.join(LOCK_FILE)).map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        let lock = {
            let mut options = private_options(true);
            options.create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(directory.join(LOCK_FILE))
                .map_err(|e| e.to_string())?
        };
        verify_private_file(&lock)?;
        let store = Self {
            directory,
            directory_handle,
            lock: Mutex::new(lock),
        };
        store.with_lock(|| Ok(()))?;
        Ok(store)
    }

    /// The caller, not frontend data or this file, attests direct-route
    /// validation. Repeated identical evidence is idempotent; replacement is
    /// forbidden even if a runtime UUID is reused by another generation.
    pub fn record(&self, generation: &str, record: &RuntimeRecord) -> Result<(), String> {
        let evidence = Evidence::from_runtime(generation, record)?;
        let bytes = serde_json::to_vec(&evidence).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Launch provenance record exceeds its size limit.".into());
        }
        self.with_lock(|| {
            if let Some(existing) = self.read_record(&evidence.runtime_id)? {
                return identical(&existing, &evidence);
            }
            self.check_capacity(bytes.len() as u64)?;
            let mut builder = tempfile::Builder::new();
            builder.prefix(".pending-").disable_cleanup(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                builder.permissions(fs::Permissions::from_mode(0o600));
            }
            #[cfg(windows)]
            let mut temporary = builder
                .make_in(&self.directory, windows_security::create_new_file)
                .map_err(|e| e.to_string())?;
            #[cfg(not(windows))]
            let mut temporary = builder
                .tempfile_in(&self.directory)
                .map_err(|e| e.to_string())?;
            // An empty file is created first. Verify its ACL/mode, link count,
            // path identity and still-pinned directory BEFORE writing payload.
            // Cleanup is disabled: a failed identity check must never unlink a
            // substituted user file. Interrupted files count toward the quota.
            self.verify_path(temporary.path(), temporary.as_file())?;
            temporary.write_all(&bytes).map_err(|e| e.to_string())?;
            temporary.as_file().sync_all().map_err(|e| e.to_string())?;
            self.verify_path(temporary.path(), temporary.as_file())?;
            let destination = self.record_path(&evidence.runtime_id)?;
            match temporary.persist_noclobber(&destination) {
                Ok(file) => {
                    self.verify_path(&destination, &file)?;
                    #[cfg(unix)]
                    self.directory_handle
                        .sync_all()
                        .map_err(|e| e.to_string())?;
                    let saved = self
                        .read_record(&evidence.runtime_id)?
                        .ok_or("Launch provenance disappeared after publication.")?;
                    identical(&saved, &evidence)
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // persist_noclobber is still mandatory despite the lock:
                    // unknown writers must never be silently overwritten.
                    let saved = self
                        .read_record(&evidence.runtime_id)?
                        .ok_or("Launch provenance disappeared during publication.")?;
                    identical(&saved, &evidence)
                }
                Err(error) => Err(error.error.to_string()),
            }
        })
    }

    /// Only current, fresh, running broker records can match. No evidence means
    /// false; corruption, unsafe permissions or replacement are explicit errors.
    /// The caller must reject an explicit broker file-input denial first.
    pub fn matches(&self, generation: &str, record: &RuntimeRecord) -> Result<bool, String> {
        let Ok(expected) = Evidence::from_runtime(generation, record) else {
            return Ok(false);
        };
        self.with_lock(|| {
            Ok(self
                .read_record(&expected.runtime_id)?
                .is_some_and(|saved| saved == expected))
        })
    }

    /// Remove only this generation's valid metadata for explicitly exited
    /// runtimes. `records` must come from an authoritative broker List from the
    /// exact generation supplied. Absence never authorizes removal: a different
    /// backend can publish new proof after this snapshot was fetched. Unknown
    /// states, inconsistent duplicates, other generations, malformed records
    /// and unfamiliar files are preserved. This never touches retained
    /// attachments, agent data or running processes.
    pub fn prune_current_generation(
        &self,
        generation: &str,
        records: &[RuntimeRecord],
    ) -> Result<(), String> {
        if !canonical_uuid(generation) {
            return Err("Invalid launch provenance generation ID.".into());
        }
        let mut exited = std::collections::HashMap::<&str, bool>::new();
        for record in records {
            let is_exited = record.info.state == "exited";
            exited
                .entry(record.info.id.as_str())
                .and_modify(|all_exited| *all_exited &= is_exited)
                .or_insert(is_exited);
        }
        self.with_lock(|| {
            // Snapshot a bounded number of entries before deleting anything.
            // One extra entry beyond the quota plus the known lock is enough
            // to detect stuffing; an overfull directory remains untouched.
            let entries = fs::read_dir(&self.directory)
                .map_err(|e| e.to_string())?
                .take(MAX_STORE_FILES + 2)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if entries.len() > MAX_STORE_FILES + 1 {
                return Err("Launch provenance has too many entries to prune safely; all files were preserved.".into());
            }
            self.check_directory()?;
            let mut removed = false;
            for entry in entries {
                let name = entry.file_name();
                let Some(runtime_id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                else {
                    continue;
                };
                if !canonical_uuid(runtime_id) || exited.get(runtime_id) != Some(&true) {
                    continue;
                }
                let (evidence, file) = match self.read_record_file(runtime_id) {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(_) => {
                        // Corrupt or unsafe entries are not ours to clean up.
                        // A substituted root still aborts the operation.
                        self.check_directory()?;
                        continue;
                    }
                };
                if evidence.generation != generation {
                    continue;
                }
                let path = self.record_path(runtime_id)?;
                // Retain the handle whose bounded payload was validated, and
                // recheck ownership, link count, path and root identity at the
                // last possible moment before unlinking this fixed UUID name.
                self.verify_path(&path, &file)?;
                fs::remove_file(&path).map_err(|e| e.to_string())?;
                self.check_directory()?;
                removed = true;
            }
            #[cfg(unix)]
            if removed {
                self.directory_handle
                    .sync_all()
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            let _ = removed;
            Ok(())
        })
    }

    fn record_path(&self, runtime_id: &str) -> Result<PathBuf, String> {
        if !canonical_uuid(runtime_id) {
            return Err("Invalid launch provenance runtime ID.".into());
        }
        Ok(self.directory.join(format!("{runtime_id}.json")))
    }

    fn check_directory(&self) -> Result<(), String> {
        if !same_file(&self.directory_handle, &open_directory(&self.directory)?)? {
            return Err("Launch provenance directory was replaced.".into());
        }
        Ok(())
    }

    fn verify_path(&self, path: &Path, expected: &File) -> Result<(), String> {
        self.check_directory()?;
        verify_private_file(expected)?;
        let current = private_options(false)
            .open(path)
            .map_err(|e| e.to_string())?;
        verify_private_file(&current)?;
        if !same_file(expected, &current)? {
            return Err("Launch provenance file was replaced.".into());
        }
        self.check_directory()
    }

    fn with_lock<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let lock = self
            .lock
            .lock()
            .map_err(|_| "Launch provenance lock is poisoned.")?;
        self.verify_path(&self.directory.join(LOCK_FILE), &lock)?;
        lock.lock().map_err(|e| e.to_string())?;
        struct Unlock<'a>(&'a File);
        impl Drop for Unlock<'_> {
            fn drop(&mut self) {
                let _ = self.0.unlock();
            }
        }
        let _unlock = Unlock(&lock);
        self.verify_path(&self.directory.join(LOCK_FILE), &lock)?;
        let result = action()?;
        self.verify_path(&self.directory.join(LOCK_FILE), &lock)?;
        Ok(result)
    }

    fn read_record(&self, runtime_id: &str) -> Result<Option<Evidence>, String> {
        Ok(self
            .read_record_file(runtime_id)?
            .map(|(evidence, _)| evidence))
    }

    fn read_record_file(&self, runtime_id: &str) -> Result<Option<(Evidence, File)>, String> {
        self.check_directory()?;
        let path = self.record_path(runtime_id)?;
        let mut file = match private_options(false).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.check_directory()?;
                // A dangling symlink is not an absent evidence file.
                if fs::symlink_metadata(&path).is_ok() {
                    return Err("Launch provenance is an invalid filesystem entry.".into());
                }
                return Ok(None);
            }
            Err(error) => return Err(error.to_string()),
        };
        self.verify_path(&path, &file)?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length == 0 || length > MAX_RECORD_BYTES {
            return Err("Launch provenance has an invalid file size.".into());
        }
        let mut bytes = Vec::with_capacity(length as usize);
        (&mut file)
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.verify_path(&path, &file)?;
        if bytes.len() as u64 != length {
            return Err(
                "Launch provenance changed while reading or exceeded its size limit.".into(),
            );
        }
        let evidence: Evidence = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        evidence.validate()?;
        if evidence.runtime_id != runtime_id {
            return Err("Launch provenance does not match its filename.".into());
        }
        Ok(Some((evidence, file)))
    }

    fn check_capacity(&self, additional_bytes: u64) -> Result<(), String> {
        self.check_directory()?;
        let mut count = 0usize;
        let mut bytes = additional_bytes;
        for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == LOCK_FILE {
                continue;
            }
            count += 1;
            let file = private_options(false)
                .open(entry.path())
                .map_err(|e| e.to_string())?;
            verify_private_file(&file)?;
            let length = file.metadata().map_err(|e| e.to_string())?.len();
            bytes = bytes.saturating_add(length);
            if count >= MAX_STORE_FILES || bytes > MAX_STORE_BYTES || length > MAX_RECORD_BYTES {
                return Err(
                    "Launch provenance storage is full; existing files were preserved.".into(),
                );
            }
        }
        self.check_directory()
    }
}

fn identical(existing: &Evidence, expected: &Evidence) -> Result<(), String> {
    if existing == expected {
        Ok(())
    } else {
        Err("Conflicting immutable launch provenance already exists for this runtime.".into())
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    #[cfg(windows)]
    windows_security::private_directory(path).map_err(|e| e.to_string())?;
    open_directory(path).map(|_| ())
}

fn private_options(write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}

fn open_directory(path: &Path) -> Result<File, String> {
    let mut options = private_options(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("Launch provenance requires a real private directory.".into());
    }
    verify_owner(&file)?;
    Ok(file)
}

fn verify_owner(file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("Launch provenance permissions are not owner-only.".into());
        }
    }
    #[cfg(windows)]
    windows_security::verify_file(file).map_err(|e| e.to_string())?;
    Ok(())
}

fn verify_private_file(file: &File) -> Result<(), String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Launch provenance requires a regular file.".into());
    }
    verify_owner(file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("Launch provenance files must not have hard links.".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: file owns a live handle, and info is a correctly sized output.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: the successful call initialized the structure.
        if unsafe { info.assume_init() }.nNumberOfLinks != 1 {
            return Err("Launch provenance files must not have hard links.".into());
        }
    }
    Ok(())
}

fn same_file(first: &File, second: &File) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let first = first.metadata().map_err(|e| e.to_string())?;
        let second = second.metadata().map_err(|e| e.to_string())?;
        Ok(first.dev() == second.dev() && first.ino() == second.ino())
    }
    #[cfg(windows)]
    {
        Ok(
            crate::windows_fs::identity_from_file(first).map_err(|e| e.to_string())?
                == crate::windows_fs::identity_from_file(second).map_err(|e| e.to_string())?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeInfo;

    fn fixture(root: &Path) -> (String, RuntimeRecord) {
        (
            Uuid::new_v4().to_string(),
            RuntimeRecord {
                provider_session_id: None,
                info: RuntimeInfo {
                    id: Uuid::new_v4().to_string(),
                    pane_id: Uuid::new_v4().to_string(),
                    session_id: None,
                    state: "running".into(),
                    cwd: fs::canonicalize(root).unwrap().to_str().unwrap().into(),
                    exit_code: None,
                },
                kind: "codex".into(),
                project_id: Some("synthetic-project".into()),
                profile_id: Some("synthetic-profile".into()),
                resume_id: None,
                home_directory: None,
                image_input: false,
                file_input: None,
            },
        )
    }

    fn private_write(path: &Path, bytes: &[u8]) {
        // Elevated Windows tokens default new files to Administrators, which the
        // store rightly rejects; fixtures need the same explicit user owner.
        #[cfg(windows)]
        if !path.exists() {
            windows_security::create_new_file(path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
            return;
        }
        let mut options = private_options(true);
        options.create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path).unwrap().write_all(bytes).unwrap();
    }

    #[test]
    fn reopens_identical_evidence_and_serializes_only_minimal_identity() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        assert!(!store.matches(&generation, &record).unwrap());
        store.record(&generation, &record).unwrap();
        store.record(&generation, &record).unwrap();
        let bytes = fs::read(store.record_path(&record.info.id).unwrap()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let keys: std::collections::BTreeSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "version",
                "generation",
                "runtimeId",
                "paneId",
                "kind",
                "cwd",
                "projectId",
                "profileId"
            ]
            .into_iter()
            .collect()
        );
        for forbidden in [
            "executable",
            "args",
            "env",
            "sessionId",
            "resumeId",
            "token",
            "secret",
            "password",
        ] {
            assert!(value.get(forbidden).is_none());
        }
        drop(store);
        let reopened = LaunchProvenance::open(temp.path()).unwrap();
        assert!(reopened.matches(&generation, &record).unwrap());
    }

    #[test]
    fn every_live_identity_and_freshness_component_is_required() {
        let temp = tempfile::tempdir().unwrap();
        let alternate = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        assert!(!store.matches(&Uuid::new_v4().to_string(), &record).unwrap());
        let mut variants = Vec::new();
        let mut changed = record.clone();
        changed.info.id = Uuid::new_v4().to_string();
        variants.push(changed);
        let mut changed = record.clone();
        changed.info.pane_id = Uuid::new_v4().to_string();
        variants.push(changed);
        let mut changed = record.clone();
        changed.kind = "claude".into();
        variants.push(changed);
        let mut changed = record.clone();
        changed.info.cwd = fs::canonicalize(alternate.path())
            .unwrap()
            .to_str()
            .unwrap()
            .into();
        variants.push(changed);
        let mut changed = record.clone();
        changed.info.session_id = Some("synthetic-session".into());
        variants.push(changed);
        let mut changed = record.clone();
        changed.resume_id = Some("synthetic-resume".into());
        variants.push(changed);
        let mut changed = record.clone();
        changed.info.state = "exited".into();
        variants.push(changed);
        let mut changed = record.clone();
        changed.info.exit_code = Some(0);
        variants.push(changed);
        let mut changed = record.clone();
        changed.project_id = None;
        variants.push(changed);
        let mut changed = record.clone();
        changed.profile_id = None;
        variants.push(changed);
        for changed in variants {
            assert!(
                !store.matches(&generation, &changed).unwrap(),
                "{changed:?}"
            );
        }
        assert!(store.matches(&generation, &record).unwrap());
    }

    #[test]
    fn accepts_only_known_direct_kinds_and_valid_backend_identities() {
        let temp = tempfile::tempdir().unwrap();
        let store = LaunchProvenance::open(temp.path()).unwrap();
        for kind in ["codex", "claude", "grok", "opencode"] {
            let (generation, mut record) = fixture(temp.path());
            record.kind = kind.into();
            store.record(&generation, &record).unwrap();
            assert!(store.matches(&generation, &record).unwrap());
        }
        let (generation, record) = fixture(temp.path());
        for kind in ["shell", "antigravity", "ssh", "wsl", "custom", ""] {
            let mut changed = record.clone();
            changed.kind = kind.into();
            assert!(store.record(&generation, &changed).is_err());
        }
        for invalid in [
            "../outside",
            "runtime",
            "",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(store.record(invalid, &record).is_err());
            let mut changed = record.clone();
            changed.info.id = invalid.into();
            assert!(store.record(&generation, &changed).is_err());
            assert!(!store.matches(&generation, &changed).unwrap());
            let mut changed = record.clone();
            changed.info.pane_id = invalid.into();
            assert!(store.record(&generation, &changed).is_err());
        }
        let mut changed = record;
        changed.info.cwd = ".".into();
        assert!(store.record(&generation, &changed).is_err());
    }

    #[test]
    fn independent_handles_serialize_identical_and_conflicting_creates() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let stores: Vec<_> = (0..4)
            .map(|_| LaunchProvenance::open(temp.path()).unwrap())
            .collect();
        let barrier = std::sync::Barrier::new(stores.len());
        std::thread::scope(|scope| {
            for store in &stores {
                scope.spawn(|| {
                    barrier.wait();
                    store.record(&generation, &record).unwrap();
                });
            }
        });
        let path = stores[0].record_path(&record.info.id).unwrap();
        let original = fs::read(&path).unwrap();
        let mut different = record.clone();
        different.info.pane_id = Uuid::new_v4().to_string();
        assert!(stores[1].record(&generation, &different).is_err());
        assert!(stores[2]
            .record(&Uuid::new_v4().to_string(), &record)
            .is_err());
        assert_eq!(original, fs::read(path).unwrap());
    }

    #[test]
    fn malformed_oversized_and_unknown_schema_fields_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        for bytes in [
            b"{broken".to_vec(),
            vec![b' '; MAX_RECORD_BYTES as usize + 1],
            Vec::new(),
        ] {
            private_write(&path, &bytes);
            assert!(store.matches(&generation, &record).is_err());
            assert!(store.record(&generation, &record).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let mut value =
            serde_json::to_value(Evidence::from_runtime(&generation, &record).unwrap()).unwrap();
        value["env"] = serde_json::json!({"SYNTHETIC_SECRET": "never-accepted"});
        private_write(&path, &serde_json::to_vec(&value).unwrap());
        assert!(store.matches(&generation, &record).is_err());
    }

    #[test]
    fn bounded_store_preserves_unfamiliar_files() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        let unfamiliar = store.directory.join("user-owned-note.txt");
        let bytes = vec![b'x'; MAX_RECORD_BYTES as usize + 1];
        private_write(&unfamiliar, &bytes);
        assert!(store.record(&generation, &record).is_err());
        assert_eq!(fs::read(&unfamiliar).unwrap(), bytes);
        assert!(!store.record_path(&record.info.id).unwrap().exists());
        fs::remove_file(&unfamiliar).unwrap(); // Only this synthetic test fixture.
        for i in 0..MAX_STORE_FILES {
            private_write(&store.directory.join(format!("fixture-{i}")), b"");
        }
        assert!(store.record(&generation, &record).is_err());
        assert_eq!(
            fs::read_dir(&store.directory).unwrap().count(),
            MAX_STORE_FILES + 1
        );
        // The exact quota is supported, but an extra entry makes pruning fail
        // before it can delete even otherwise eligible current-generation data.
        let evidence = Evidence::from_runtime(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        let bytes = serde_json::to_vec(&evidence).unwrap();
        private_write(&path, &bytes);
        let mut exited = record.clone();
        exited.info.state = "exited".into();
        assert!(store
            .prune_current_generation(&generation, &[exited])
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::read_dir(&store.directory).unwrap().count(),
            MAX_STORE_FILES + 2
        );
    }

    #[test]
    fn pruning_preserves_live_other_generations_unknown_and_corrupt_entries() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, live) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        let mut stopping = fixture(temp.path()).1;
        let mut unknown = fixture(temp.path()).1;
        let mut finished = fixture(temp.path()).1;
        let absent = fixture(temp.path()).1;
        let (other_generation, foreign) = fixture(temp.path());
        for record in [&live, &stopping, &unknown, &finished, &absent] {
            store.record(&generation, record).unwrap();
        }
        store.record(&other_generation, &foreign).unwrap();
        stopping.info.state = "stopping".into();
        unknown.info.state = "unrecognized-state".into();
        finished.info.state = "exited".into();
        let mut foreign_exited = foreign.clone();
        foreign_exited.info.state = "exited".into();
        let mut inconsistent_duplicate = live.clone();
        inconsistent_duplicate.info.state = "exited".into();
        let mut corrupt_runtime = fixture(temp.path()).1;
        corrupt_runtime.info.state = "exited".into();
        let corrupt = store.record_path(&corrupt_runtime.info.id).unwrap();
        private_write(&corrupt, b"{incomplete");
        let unfamiliar = store.directory.join("user-owned.json");
        let interrupted = store.directory.join(".pending-synthetic");
        private_write(&unfamiliar, b"preserve unfamiliar data");
        private_write(&interrupted, b"preserve interrupted write");
        assert!(store.prune_current_generation("invalid", &[]).is_err());
        assert!(store.record_path(&absent.info.id).unwrap().exists());
        store
            .prune_current_generation(
                &generation,
                &[
                    live.clone(),
                    stopping.clone(),
                    unknown.clone(),
                    finished.clone(),
                    foreign_exited,
                    corrupt_runtime,
                    inconsistent_duplicate,
                ],
            )
            .unwrap();
        for record in [&live, &stopping, &unknown, &foreign, &absent] {
            assert!(store.record_path(&record.info.id).unwrap().exists());
        }
        assert!(!store.record_path(&finished.info.id).unwrap().exists());
        assert!(store.matches(&generation, &live).unwrap());
        assert!(store.matches(&other_generation, &foreign).unwrap());
        assert_eq!(fs::read(&corrupt).unwrap(), b"{incomplete");
        assert_eq!(fs::read(&unfamiliar).unwrap(), b"preserve unfamiliar data");
        assert_eq!(
            fs::read(&interrupted).unwrap(),
            b"preserve interrupted write"
        );
    }

    #[test]
    fn pruning_completed_current_generation_records_frees_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, live) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &live).unwrap();
        let mut authoritative = vec![live.clone()];
        // Fill with valid synthetic completed records without quadratic quota
        // scanning. They have the exact same schema and private permissions.
        for _ in 1..MAX_STORE_FILES {
            let mut old = fixture(temp.path()).1;
            let evidence = Evidence::from_runtime(&generation, &old).unwrap();
            private_write(
                &store.record_path(&old.info.id).unwrap(),
                &serde_json::to_vec(&evidence).unwrap(),
            );
            old.info.state = "exited".into();
            authoritative.push(old);
        }
        let fresh = fixture(temp.path()).1;
        assert!(store.record(&generation, &fresh).is_err());
        store
            .prune_current_generation(&generation, &authoritative)
            .unwrap();
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 2);
        store.record(&generation, &fresh).unwrap();
        assert!(store.matches(&generation, &live).unwrap());
        assert!(store.matches(&generation, &fresh).unwrap());
    }

    #[test]
    fn stale_empty_snapshot_cannot_prune_another_backends_new_live_proof() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let observer = LaunchProvenance::open(temp.path()).unwrap();
        let launcher = LaunchProvenance::open(temp.path()).unwrap();
        // Backend B observes no runtimes. Backend A then launches and publishes
        // proof before B acquires the store lock to prune its stale snapshot.
        let earlier_snapshot = Vec::<RuntimeRecord>::new();
        launcher.record(&generation, &record).unwrap();
        observer
            .prune_current_generation(&generation, &earlier_snapshot)
            .unwrap();
        assert!(observer.matches(&generation, &record).unwrap());
        assert!(launcher.matches(&generation, &record).unwrap());
        let mut explicitly_exited = record.clone();
        explicitly_exited.info.state = "exited".into();
        observer
            .prune_current_generation(&generation, &[explicitly_exited])
            .unwrap();
        assert!(!launcher.matches(&generation, &record).unwrap());
    }

    #[test]
    fn pruning_preserves_hardlinked_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        let alias = store.directory.join("preserved-alias");
        fs::hard_link(&path, &alias).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut exited = record.clone();
        exited.info.state = "exited".into();
        store
            .prune_current_generation(&generation, &[exited])
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read(&alias).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn pruning_preserves_symlinks_and_unsafe_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        let bytes = fs::read(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let mut exited = record.clone();
        exited.info.state = "exited".into();
        let mut linked = exited.clone();
        linked.info.id = Uuid::new_v4().to_string();
        let link = store.record_path(&linked.info.id).unwrap();
        symlink(&path, &link).unwrap();
        store
            .prune_current_generation(&generation, &[exited, linked])
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
    }

    #[test]
    fn hard_links_are_rejected_without_changing_either_path() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        let alias = store.directory.join("other-hardlink");
        fs::hard_link(&path, &alias).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(store.matches(&generation, &record).is_err());
        assert!(store.record(&generation, &record).is_err());
        assert_eq!(fs::read(&alias).unwrap(), bytes);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_unsafe_modes_and_replaced_root_or_lock() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.matches(&generation, &record).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let original = store.directory.join("original.json");
        fs::rename(&path, &original).unwrap();
        symlink(&original, &path).unwrap();
        assert!(store.matches(&generation, &record).is_err());
        fs::remove_file(&path).unwrap();
        fs::rename(&original, &path).unwrap();
        let lock = store.directory.join(LOCK_FILE);
        fs::rename(&lock, store.directory.join("original.lock")).unwrap();
        private_write(&lock, b"");
        assert!(store.matches(&generation, &record).is_err());
        drop(store);
        let store = LaunchProvenance::open(temp.path()).unwrap();
        let previous = temp.path().join("old-provenance");
        fs::rename(&store.directory, &previous).unwrap();
        private_directory(&store.directory).unwrap();
        private_write(
            &store.record_path(&record.info.id).unwrap(),
            &fs::read(previous.join(format!("{}.json", record.info.id))).unwrap(),
        );
        assert!(store.matches(&generation, &record).is_err());
        assert!(store.record(&generation, &record).is_err());
        assert!(store.prune_current_generation(&generation, &[]).is_err());
        fs::remove_dir_all(&store.directory).unwrap(); // Only synthetic fixture data.
        symlink(&previous, &store.directory).unwrap();
        assert!(LaunchProvenance::open(temp.path()).is_err());
        fs::remove_file(&store.directory).unwrap();
        fs::rename(&previous, &store.directory).unwrap();
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(LaunchProvenance::open(temp.path()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_reparse_files_when_fixture_privilege_is_available() {
        let temp = tempfile::tempdir().unwrap();
        let (generation, record) = fixture(temp.path());
        let store = LaunchProvenance::open(temp.path()).unwrap();
        store.record(&generation, &record).unwrap();
        let path = store.record_path(&record.info.id).unwrap();
        let original = store.directory.join("original.json");
        fs::rename(&path, &original).unwrap();
        match std::os::windows::fs::symlink_file(&original, &path) {
            Ok(()) => {
                assert!(store.matches(&generation, &record).is_err());
                let mut exited = record.clone();
                exited.info.state = "exited".into();
                store
                    .prune_current_generation(&generation, &[exited])
                    .unwrap();
                assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
                assert!(original.exists());
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("SKIPPED synthetic symlink: Windows requires Developer Mode or symlink privilege ({error})");
            }
            Err(error) => panic!("Cannot create synthetic symlink: {error}"),
        }
    }
}
