//! Read-only, catalog-scoped workspace preview. Never canonicalize and then open
//! an untrusted path: every component is resolved relative to an owned directory
//! descriptor, with symlink following disabled in the actual open operation.
use crate::models::{
    WorkspaceFileChunk, WorkspaceFileInfo, WorkspaceFileKind, WorkspaceFilePage,
    WorkspaceFilePreview, WorkspaceFileSearch,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const PAGE_SIZE: usize = 200;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const SAMPLE_BYTES: usize = 64 * 1024;
const FILE_CHANGED: &str = "檔案在讀取期間已變更，請重新開啟";

#[derive(Debug, PartialEq, Eq)]
struct FileSnapshot {
    size_bytes: u64,
    version: String,
}

fn opaque_version(identity: &str) -> String {
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn is_text_sample(bytes: &[u8], eof: bool) -> bool {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        // A bounded sample may end inside a multibyte codepoint. This is not
        // proof of an invalid encoding unless these are the actual final bytes.
        Err(error) if !eof && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return false,
    };
    !text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

/// Every call opens its own securely resolved descriptor. The version is an
/// equality token, never a capability to read another project or an old handle.
pub(crate) fn inspect(root: &Path, path: &str) -> Result<WorkspaceFileInfo, String> {
    let parts = relative_parts(path, false)?;
    let mut file = platform::open_file(root, &parts)?;
    let snapshot = platform::snapshot(&file)?;
    let sample = read_opened_chunk(&mut file, &snapshot, 0, SAMPLE_BYTES)?;
    Ok(WorkspaceFileInfo {
        path: path.to_owned(),
        size_bytes: snapshot.size_bytes,
        version: snapshot.version,
        kind: if crate::workspace_images::recognizes(&sample.bytes) {
            WorkspaceFileKind::Image
        } else if is_text_sample(&sample.bytes, sample.eof) {
            WorkspaceFileKind::Text
        } else {
            WorkspaceFileKind::Binary
        },
    })
}

/// Read one capped revision through the same secure descriptor resolution used
/// by text chunks. Never pass a filesystem path to an image decoder.
pub(crate) fn read_bounded(
    root: &Path,
    path: &str,
    version: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let parts = relative_parts(path, false)?;
    if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(FILE_CHANGED.into());
    }
    let mut file = platform::open_file(root, &parts)?;
    let snapshot = platform::snapshot(&file)?;
    if snapshot.version != version {
        return Err(FILE_CHANGED.into());
    }
    if snapshot.size_bytes == 0 || snapshot.size_bytes > max_bytes as u64 {
        return Err("圖片大小必須介於 1 byte 與 10 MiB".into());
    }
    Ok(read_opened_chunk(&mut file, &snapshot, 0, max_bytes)?.bytes)
}

pub(crate) fn read_chunk(
    root: &Path,
    path: &str,
    version: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<WorkspaceFileChunk, String> {
    let parts = relative_parts(path, false)?;
    if !(1..=MAX_CHUNK_BYTES).contains(&max_bytes) {
        return Err("單次讀取大小必須介於 1 byte 與 256 KiB".into());
    }
    if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(FILE_CHANGED.into());
    }
    let mut file = platform::open_file(root, &parts)?;
    let snapshot = platform::snapshot(&file)?;
    if snapshot.version != version {
        return Err(FILE_CHANGED.into());
    }
    read_opened_chunk(&mut file, &snapshot, offset, max_bytes)
}

fn read_opened_chunk(
    file: &mut File,
    before: &FileSnapshot,
    offset: u64,
    max_bytes: usize,
) -> Result<WorkspaceFileChunk, String> {
    let remaining = before
        .size_bytes
        .checked_sub(offset)
        .ok_or("讀取位置超過檔案大小，請重新開啟")?;
    let length = remaining.min(max_bytes as u64);
    file.seek(SeekFrom::Start(offset))
        .map_err(platform::fs_error)?;
    let mut bytes = Vec::with_capacity(length as usize);
    Read::by_ref(file)
        .take(length)
        .read_to_end(&mut bytes)
        .map_err(platform::fs_error)?;
    // Check the same opened file, including identity/link/type checks, after
    // the read. A later call reopens and compares this revision again.
    if &platform::snapshot(file)? != before || bytes.len() as u64 != length {
        return Err(FILE_CHANGED.into());
    }
    Ok(WorkspaceFileChunk {
        bytes,
        eof: length == remaining,
    })
}
// Pagination is sorted within a single directory, never a recursive tree scan.
// Bound its snapshot independently of the response and caller-controlled offset.
const MAX_DIRECTORY_ENTRIES: usize = 100_000;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const MAX_DIRECTORY_NAME_BYTES: usize = 16 * 1024 * 1024;

fn valid_name(name: &str) -> bool {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.ends_with(['.', ' '])
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    // Apply these rules on all hosts, so IPC cannot acquire different meanings
    // on Windows (ADS, device names, drive-relative paths, UNC, or normalization).
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].contains(&stem.as_str()) {
        return false;
    }
    !["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn relative_parts(path: &str, allow_root: bool) -> Result<Vec<&str>, String> {
    if path.is_empty() && allow_root {
        return Ok(Vec::new());
    }
    if path.len() > MAX_PATH_BYTES || !path.split('/').all(valid_name) {
        return Err("檔案路徑必須是專案內的相對路徑，不可包含上層目錄、裝置名稱或串流".into());
    }
    Ok(path.split('/').collect())
}

pub(crate) fn list(
    root: &Path,
    path: &str,
    offset: usize,
    show_hidden: bool,
) -> Result<WorkspaceFilePage, String> {
    let parts = relative_parts(path, true)?;
    if offset > MAX_DIRECTORY_ENTRIES {
        return Err("目錄分頁位置超過上限，請重新整理".into());
    }
    platform::list(root, path, &parts, offset, show_hidden)
}

// Filename/path search includes hidden names, but never file contents or links.
// The elapsed budget is cooperative between filesystem calls, not an I/O timeout.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const SEARCH_MAX_RESULTS: usize = 50;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const SEARCH_MAX_ENTRIES: usize = 20_000;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const SEARCH_MAX_DEPTH: usize = 32;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const SEARCH_MAX_DURATION: std::time::Duration = std::time::Duration::from_millis(250);

pub(crate) fn search(root: &Path, query: &str) -> Result<WorkspaceFileSearch, String> {
    if query.len() > 256 || query.chars().any(char::is_control) {
        return Err("搜尋文字不可超過 256 bytes 或包含控制字元".into());
    }
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(WorkspaceFileSearch {
            paths: Vec::new(),
            truncated: false,
        });
    }
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    {
        platform::search(root, &query)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = root;
        Err("此平台尚未支援安全遞迴檔名搜尋".into())
    }
}

pub(crate) fn read(root: &Path, path: &str) -> Result<WorkspaceFilePreview, String> {
    let parts = relative_parts(path, false)?;
    platform::read(root, path, &parts)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
    use super::*;
    use crate::models::{WorkspaceEntry, WorkspaceEntryKind};
    use std::{
        ffi::{CStr, CString},
        io,
        mem::MaybeUninit,
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::Component,
        ptr::NonNull,
    };

    pub(super) fn fs_error(error: io::Error) -> String {
        match error.kind() {
            io::ErrorKind::NotFound => "檔案或目錄已不存在，請重新整理".into(),
            io::ErrorKind::PermissionDenied => "沒有權限讀取此檔案或目錄".into(),
            _ => format!("無法安全讀取：不允許符號連結或非一般檔案／目錄（{error}）"),
        }
    }

    // Diagnostics deliberately contain only fixed operation/stage labels and
    // numeric positions/errno. Never pass paths, entry names or error Display.
    #[derive(Clone, Copy)]
    enum OpenStage {
        FilesystemRoot,
        ProjectAncestor(usize),
        RelativeDirectory(usize),
        PreviewFile,
    }

    impl OpenStage {
        fn diagnostic(self) -> String {
            match self {
                Self::FilesystemRoot => "filesystem-root".into(),
                Self::ProjectAncestor(index) => format!("project-ancestor:{index}"),
                Self::RelativeDirectory(index) => format!("relative-directory:{index}"),
                Self::PreviewFile => "preview-file".into(),
            }
        }
    }

    fn diagnostic_error(error: io::Error, operation: &'static str, stage: &str) -> String {
        let errno = error
            .raw_os_error()
            .map_or_else(|| "none".into(), |code| code.to_string());
        let message = match error.kind() {
            io::ErrorKind::NotFound => "檔案或目錄已不存在，請重新整理",
            io::ErrorKind::PermissionDenied => "沒有權限讀取此檔案或目錄",
            _ => "無法安全讀取：不允許符號連結或非一般檔案／目錄",
        };
        format!("{message} [workspace-files operation={operation} stage={stage} errno={errno}]")
    }

    fn c_name(name: &[u8]) -> Result<CString, String> {
        CString::new(name).map_err(|_| "檔案路徑不可包含空字元".into())
    }

    fn open_at(
        parent: RawFd,
        name: &CStr,
        directory: bool,
        stage: OpenStage,
    ) -> Result<File, String> {
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        // SAFETY: parent is an owned live directory descriptor (or AT_FDCWD for
        // the literal filesystem root); name is NUL-terminated. No creation.
        let descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(diagnostic_error(
                io::Error::last_os_error(),
                "openat",
                &stage.diagnostic(),
            ));
        }
        // SAFETY: openat returned a new descriptor, whose sole owner is File.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn open_root(root: &Path) -> Result<File, String> {
        let text = root.to_str().ok_or("專案目錄不是有效的 UTF-8 本機路徑")?;
        if !root.is_absolute()
            || text.starts_with("//")
            || text.contains('\\')
            || text.split('/').any(|part| matches!(part, "." | ".."))
            || text.chars().any(char::is_control)
        {
            return Err("專案必須有絕對本機目錄，無法預覽遠端或未知路徑".into());
        }
        let mut directory = open_at(libc::AT_FDCWD, c"/", true, OpenStage::FilesystemRoot)?;
        let mut ancestor_index = 0;
        for component in root.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    ancestor_index += 1;
                    directory = open_at(
                        directory.as_raw_fd(),
                        &c_name(name.as_bytes())?,
                        true,
                        OpenStage::ProjectAncestor(ancestor_index),
                    )?;
                }
                _ => return Err("專案目錄含有不支援的路徑成分".into()),
            }
        }
        Ok(directory)
    }

    fn descend(mut directory: File, parts: &[&str]) -> Result<File, String> {
        for (index, part) in parts.iter().enumerate() {
            directory = open_at(
                directory.as_raw_fd(),
                &c_name(part.as_bytes())?,
                true,
                OpenStage::RelativeDirectory(index + 1),
            )?;
        }
        Ok(directory)
    }

    fn stat_at(directory: RawFd, name: &CStr) -> io::Result<libc::stat> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the directory descriptor and C string are live. fstatat writes
        // a complete stat on success; AT_SYMLINK_NOFOLLOW never follows links.
        let result = unsafe {
            libc::fstatat(
                directory,
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful fstatat initialized the entire output structure.
        Ok(unsafe { stat.assume_init() })
    }

    struct DirectoryStream(NonNull<libc::DIR>);

    impl DirectoryStream {
        fn new(directory: File) -> Result<Self, String> {
            let descriptor = directory.into_raw_fd();
            // SAFETY: fdopendir receives ownership of a valid directory fd on
            // success. On failure it leaves ownership with us.
            match NonNull::new(unsafe { libc::fdopendir(descriptor) }) {
                Some(stream) => Ok(Self(stream)),
                None => {
                    let error = io::Error::last_os_error();
                    // SAFETY: fdopendir failed without taking ownership.
                    drop(unsafe { File::from_raw_fd(descriptor) });
                    Err(diagnostic_error(error, "fdopendir", "selected-directory"))
                }
            }
        }

        fn descriptor(&self) -> RawFd {
            // SAFETY: self owns this live DIR stream.
            unsafe { libc::dirfd(self.0.as_ptr()) }
        }

        fn next_name(&mut self) -> Result<Option<String>, String> {
            // readdir reports both EOF and error through NULL. Clear and inspect
            // thread-local errno around each call to avoid silently truncating.
            #[cfg(target_os = "linux")]
            // SAFETY: libc returns this thread's valid errno pointer.
            let errno = unsafe { libc::__errno_location() };
            #[cfg(target_os = "macos")]
            // SAFETY: libc returns this thread's valid errno pointer.
            let errno = unsafe { libc::__error() };
            // SAFETY: errno is thread-local; this owned DIR is accessed serially.
            let entry = unsafe {
                *errno = 0;
                libc::readdir(self.0.as_ptr())
            };
            if entry.is_null() {
                // SAFETY: the thread-local errno pointer remains valid.
                let code = unsafe { *errno };
                return if code == 0 {
                    Ok(None)
                } else {
                    Err(diagnostic_error(
                        io::Error::from_raw_os_error(code),
                        "readdir",
                        "selected-directory",
                    ))
                };
            }
            // SAFETY: readdir returned a live entry with NUL-terminated d_name;
            // copy the name before the next call can overwrite its storage.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            name.to_str()
                .map(|name| Some(name.to_owned()))
                .map_err(|_| "目錄含有非 UTF-8 檔名，無法安全顯示".into())
        }
    }

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            // SAFETY: this guard uniquely owns the DIR and its descriptor.
            unsafe { libc::closedir(self.0.as_ptr()) };
        }
    }

    pub(super) fn list(
        root: &Path,
        path: &str,
        parts: &[&str],
        offset: usize,
        show_hidden: bool,
    ) -> Result<WorkspaceFilePage, String> {
        let directory = descend(open_root(root)?, parts)?;
        let mut stream = DirectoryStream::new(directory)?;
        let mut entries = Vec::new();
        let mut seen = 0;
        let mut name_bytes = 0;
        while let Some(name) = stream.next_name()? {
            if matches!(name.as_str(), "." | "..") {
                continue;
            }
            seen += 1;
            name_bytes += name.len();
            if seen > MAX_DIRECTORY_ENTRIES || name_bytes > MAX_DIRECTORY_NAME_BYTES {
                return Err("目錄過大：最多可預覽 100,000 個項目及 16 MiB 的檔名".into());
            }
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let stat = stat_at(stream.descriptor(), &c_name(name.as_bytes())?);
            let kind = if valid_name(&name) {
                match stat {
                    Ok(stat) if stat.st_mode & libc::S_IFMT == libc::S_IFDIR => {
                        WorkspaceEntryKind::Directory
                    }
                    Ok(stat)
                        if stat.st_mode & libc::S_IFMT == libc::S_IFREG && stat.st_nlink == 1 =>
                    {
                        WorkspaceEntryKind::File
                    }
                    _ => WorkspaceEntryKind::Blocked,
                }
            } else {
                WorkspaceEntryKind::Blocked
            };
            entries.push((name, kind));
        }
        entries.sort_unstable_by(|a, b| {
            let rank = |kind| u8::from(kind != WorkspaceEntryKind::Directory);
            rank(a.1).cmp(&rank(b.1)).then_with(|| a.0.cmp(&b.0))
        });
        let end = offset.saturating_add(PAGE_SIZE).min(entries.len());
        let next_offset = (end < entries.len()).then_some(end);
        // Construct repeated path prefixes only for the bounded response page.
        let entries = entries
            .into_iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .map(|(name, kind)| WorkspaceEntry {
                path: if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}/{name}")
                },
                name,
                kind,
            })
            .collect();
        Ok(WorkspaceFilePage {
            entries,
            next_offset,
        })
    }

    struct SearchState<'a> {
        query: &'a str,
        result: WorkspaceFileSearch,
        seen: usize,
        started: std::time::Instant,
        max_entries: usize,
        max_depth: usize,
        duration: std::time::Duration,
    }

    impl SearchState<'_> {
        fn exhausted(&mut self) -> bool {
            if self.seen >= self.max_entries || self.started.elapsed() >= self.duration {
                self.result.truncated = true;
                return true;
            }
            false
        }

        fn visit(&mut self, directory: File, prefix: &str, depth: usize) -> Result<bool, String> {
            let mut stream = DirectoryStream::new(directory)?;
            loop {
                if self.exhausted() {
                    return Ok(false);
                }
                let Some(name) = stream.next_name()? else {
                    return Ok(true);
                };
                if matches!(name.as_str(), "." | "..") {
                    continue;
                }
                self.seen += 1;
                if !valid_name(&name) {
                    continue;
                }
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if path.len() > MAX_PATH_BYTES {
                    self.result.truncated = true;
                    continue;
                }
                let name_c = c_name(name.as_bytes())?;
                let Ok(stat) = stat_at(stream.descriptor(), &name_c) else {
                    self.result.truncated = true;
                    continue;
                };
                match stat.st_mode & libc::S_IFMT {
                    libc::S_IFDIR => {
                        if [".git", "node_modules", "target", "dist"].contains(&name.as_str()) {
                            continue;
                        }
                        if depth >= self.max_depth {
                            self.result.truncated = true;
                            continue;
                        }
                        // Hold parent descriptors throughout depth-first traversal. No
                        // path reopen, symlink following, or unbounded directory queue.
                        match open_at(
                            stream.descriptor(),
                            &name_c,
                            true,
                            OpenStage::RelativeDirectory(depth + 1),
                        ) {
                            Ok(child) => {
                                if !self.visit(child, &path, depth + 1)? {
                                    return Ok(false);
                                }
                            }
                            Err(_) => self.result.truncated = true,
                        }
                    }
                    libc::S_IFREG
                        if stat.st_nlink == 1 && path.to_lowercase().contains(self.query) =>
                    {
                        if self.result.paths.len() == SEARCH_MAX_RESULTS {
                            self.result.truncated = true;
                            return Ok(false);
                        }
                        self.result.paths.push(path);
                    }
                    _ => {}
                }
            }
        }
    }

    pub(super) fn search(root: &Path, query: &str) -> Result<WorkspaceFileSearch, String> {
        let mut state = SearchState {
            query,
            result: WorkspaceFileSearch {
                paths: Vec::new(),
                truncated: false,
            },
            seen: 0,
            started: std::time::Instant::now(),
            max_entries: SEARCH_MAX_ENTRIES,
            max_depth: SEARCH_MAX_DEPTH,
            duration: SEARCH_MAX_DURATION,
        };
        state.visit(open_root(root)?, "", 0)?;
        state.result.paths.sort_unstable();
        Ok(state.result)
    }

    fn open_file_from(directory: File, parts: &[&str]) -> Result<File, String> {
        let (name, parents) = parts.split_last().ok_or("請選擇一般文字檔案")?;
        let directory = descend(directory, parents)?;
        let name = c_name(name.as_bytes())?;
        let before = stat_at(directory.as_raw_fd(), &name).map_err(fs_error)?;
        if before.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err("只能預覽一般檔案，不支援符號連結、目錄或特殊檔案".into());
        }
        // O_NONBLOCK avoids blocking if a regular file is replaced by a FIFO
        // between fstatat and openat. O_NOFOLLOW prevents a symlink replacement.
        let file = open_at(directory.as_raw_fd(), &name, false, OpenStage::PreviewFile)?;
        let metadata = file.metadata().map_err(fs_error)?;
        if !metadata.is_file()
            || metadata.dev() != before.st_dev as u64
            || metadata.ino() != before.st_ino as u64
        {
            return Err("檔案在讀取前已變更，請重新整理；只能預覽一般檔案".into());
        }
        // A regular-file alias may share an inode with a name outside this root.
        // Validate the opened descriptor, not only the earlier directory entry.
        if metadata.nlink() > 1 {
            return Err("多重硬連結不支援：無法預覽與其他路徑共用的檔案".into());
        }
        Ok(file)
    }

    pub(super) fn open_file(root: &Path, parts: &[&str]) -> Result<File, String> {
        open_file_from(open_root(root)?, parts)
    }

    pub(super) fn snapshot(file: &File) -> Result<FileSnapshot, String> {
        let metadata = file.metadata().map_err(fs_error)?;
        if !metadata.is_file() {
            return Err("只能預覽一般檔案".into());
        }
        if metadata.nlink() != 1 {
            return Err("多重硬連結或已移除檔案不支援：請重新開啟".into());
        }
        Ok(FileSnapshot {
            size_bytes: metadata.len(),
            version: opaque_version(&format!(
                "unix:{}:{}:{}:{}:{}:{}:{}",
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )),
        })
    }

    fn read_from(
        directory: File,
        path: &str,
        parts: &[&str],
    ) -> Result<WorkspaceFilePreview, String> {
        let mut file = open_file_from(directory, parts)?;
        let metadata = file.metadata().map_err(fs_error)?;
        if metadata.len() > MAX_FILE_BYTES as u64 {
            return Err("檔案過大：文字預覽上限為 256 KiB".into());
        }
        let mut bytes = Vec::new();
        // The second bound also protects against a concurrently growing file.
        Read::by_ref(&mut file)
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(fs_error)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("檔案過大：文字預覽上限為 256 KiB".into());
        }
        let size_bytes = bytes.len();
        let text = String::from_utf8(bytes)
            .map_err(|_| "不支援此檔案編碼：只能預覽 UTF-8 文字".to_owned())?;
        if text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err("不支援二進位或含控制字元的檔案，只能預覽 UTF-8 文字".into());
        }
        Ok(WorkspaceFilePreview {
            path: path.to_owned(),
            text,
            size_bytes,
        })
    }

    pub(super) fn read(
        root: &Path,
        path: &str,
        parts: &[&str],
    ) -> Result<WorkspaceFilePreview, String> {
        read_from(open_root(root)?, path, parts)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs, os::unix::fs::symlink};

        #[test]
        fn recursive_search_entry_and_time_budgets_are_enforced() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            fs::write(root.join("one.txt"), "").unwrap();
            fs::write(root.join("two.txt"), "").unwrap();
            for (max_entries, duration) in
                [(1, SEARCH_MAX_DURATION), (100, std::time::Duration::ZERO)]
            {
                let mut state = SearchState {
                    query: "txt",
                    result: WorkspaceFileSearch {
                        paths: Vec::new(),
                        truncated: false,
                    },
                    seen: 0,
                    started: std::time::Instant::now(),
                    max_entries,
                    max_depth: SEARCH_MAX_DEPTH,
                    duration,
                };
                assert!(!state.visit(open_root(&root).unwrap(), "", 0).unwrap());
                assert!(state.result.truncated);
                assert!(state.seen <= max_entries);
                assert!(state.result.paths.len() <= 1);
            }
        }

        #[test]
        fn diagnostics_distinguish_errno_without_disclosing_error_payloads() {
            for errno in [libc::EPERM, libc::EACCES] {
                let message = diagnostic_error(
                    io::Error::from_raw_os_error(errno),
                    "openat",
                    "project-ancestor:3",
                );
                assert_eq!(message, format!("沒有權限讀取此檔案或目錄 [workspace-files operation=openat stage=project-ancestor:3 errno={errno}]"));
            }
            let secret = "private-directory/private-file/private-content";
            let message =
                diagnostic_error(io::Error::other(secret), "readdir", "selected-directory");
            assert!(!message.contains(secret));
            assert!(message.ends_with("operation=readdir stage=selected-directory errno=none]"));
        }

        #[test]
        fn directory_stream_failure_reports_operation_without_filename() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("synthetic-private-file");
            fs::write(&path, "synthetic content").unwrap();
            let error = DirectoryStream::new(File::open(&path).unwrap())
                .err()
                .unwrap();
            assert!(error.contains(&format!(
                "operation=fdopendir stage=selected-directory errno={}",
                libc::ENOTDIR
            )));
            assert!(!error.contains("synthetic-private-file"));
            assert!(!error.contains("synthetic content"));
        }

        #[test]
        fn diagnostic_stages_are_fixed_labels_and_numeric_indices() {
            assert_eq!(OpenStage::FilesystemRoot.diagnostic(), "filesystem-root");
            assert_eq!(
                OpenStage::ProjectAncestor(3).diagnostic(),
                "project-ancestor:3"
            );
            assert_eq!(
                OpenStage::RelativeDirectory(2).diagnostic(),
                "relative-directory:2"
            );
            assert_eq!(OpenStage::PreviewFile.diagnostic(), "preview-file");
        }

        #[test]
        fn open_failure_reports_stage_not_entry_name() {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("synthetic-private-project");
            let expected_index = root
                .components()
                .filter(|part| matches!(part, Component::Normal(_)))
                .count();
            let message = open_root(&root).unwrap_err();
            assert!(message.contains(&format!(
                "operation=openat stage=project-ancestor:{expected_index} errno={}",
                libc::ENOENT
            )));
            assert!(!message.contains("synthetic-private-project"));
            assert!(!message.contains(base.to_str().unwrap()));
        }

        #[test]
        fn descriptor_stays_on_original_root_after_path_is_replaced_by_outside_link() {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("project");
            let outside = base.join("outside");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(root.join("file.txt"), "inside").unwrap();
            fs::write(outside.join("file.txt"), "outside must not leak").unwrap();
            let pinned = open_root(&root).unwrap();
            fs::rename(&root, base.join("old-project")).unwrap();
            symlink(&outside, &root).unwrap();
            let result = read_from(pinned, "file.txt", &["file.txt"]).unwrap();
            assert_eq!(result.text, "inside");
            assert!(read(&root, "file.txt", &["file.txt"]).is_err());
        }

        #[test]
        fn chunk_checks_revision_and_hardlinks_again_on_the_opened_descriptor() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let path = root.join("synthetic.txt");
            fs::write(&path, "initial").unwrap();
            let mut file = open_file(&root, &["synthetic.txt"]).unwrap();
            let before = snapshot(&file).unwrap();
            fs::write(&path, "grown after snapshot").unwrap();
            assert_eq!(
                read_opened_chunk(&mut file, &before, 0, MAX_CHUNK_BYTES).unwrap_err(),
                FILE_CHANGED
            );
            let before = snapshot(&file).unwrap();
            fs::write(&path, "x").unwrap();
            assert_eq!(
                read_opened_chunk(&mut file, &before, 0, MAX_CHUNK_BYTES).unwrap_err(),
                FILE_CHANGED
            );
            let before = snapshot(&file).unwrap();
            fs::hard_link(&path, root.join("alias.txt")).unwrap();
            assert!(read_opened_chunk(&mut file, &before, 0, MAX_CHUNK_BYTES)
                .unwrap_err()
                .contains("多重硬連結"));
        }

        #[test]
        fn chunk_descriptor_stays_pinned_after_root_path_replacement() {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("project");
            let outside = base.join("outside");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(root.join("file.txt"), "inside").unwrap();
            fs::write(outside.join("file.txt"), "outside must not leak").unwrap();
            let pinned = open_root(&root).unwrap();
            fs::rename(&root, base.join("old-project")).unwrap();
            symlink(&outside, &root).unwrap();
            let mut file = open_file_from(pinned, &["file.txt"]).unwrap();
            let before = snapshot(&file).unwrap();
            let chunk = read_opened_chunk(&mut file, &before, 0, MAX_CHUNK_BYTES).unwrap();
            assert_eq!(chunk.bytes, b"inside");
            assert!(chunk.eof);
            assert!(super::super::inspect(&root, "file.txt").is_err());
        }

        #[test]
        fn replaced_intermediate_component_cannot_escape_pinned_root() {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("project");
            let outside = base.join("outside");
            fs::create_dir_all(root.join("sub")).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("file.txt"), "outside must not leak").unwrap();
            let pinned = open_root(&root).unwrap();
            fs::rename(root.join("sub"), root.join("old-sub")).unwrap();
            symlink(&outside, root.join("sub")).unwrap();
            assert!(read_from(pinned, "sub/file.txt", &["sub", "file.txt"]).is_err());
        }
    }
}

#[cfg(windows)]
#[path = "workspace_files_windows.rs"]
mod platform;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use super::*;

    const UNSUPPORTED: &str =
        "此平台尚未支援安全檔案預覽：無法保證拒絕目錄連結／重新解析點，因此已停用讀取";

    pub(super) fn fs_error(error: std::io::Error) -> String {
        error.to_string()
    }

    pub(super) fn open_file(_root: &Path, _parts: &[&str]) -> Result<File, String> {
        Err(UNSUPPORTED.into())
    }

    pub(super) fn snapshot(_file: &File) -> Result<FileSnapshot, String> {
        Err(UNSUPPORTED.into())
    }

    pub(super) fn list(
        _root: &Path,
        _path: &str,
        _parts: &[&str],
        _offset: usize,
        _show_hidden: bool,
    ) -> Result<WorkspaceFilePage, String> {
        Err(UNSUPPORTED.into())
    }

    pub(super) fn read(
        _root: &Path,
        _path: &str,
        _parts: &[&str],
    ) -> Result<WorkspaceFilePreview, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_parser_rejects_traversal_devices_streams_and_ambiguity() {
        for path in [
            "",
            ".",
            "..",
            "../secret",
            "a/../secret",
            "a/./b",
            "a//b",
            "a/",
            "/secret",
            "C:/secret",
            "C:secret",
            "\\\\host\\share",
            "a\\b",
            "file:stream",
            "CON",
            "con.txt",
            "COM1",
            "LPT².txt",
            "trailing.",
            "trailing ",
            "a\0b",
            "a\nb",
        ] {
            assert!(relative_parts(path, false).is_err(), "accepted {path:?}");
        }
        assert!(relative_parts("", true).unwrap().is_empty());
        assert!(relative_parts(&"a".repeat(MAX_PATH_BYTES + 1), false).is_err());
        assert_eq!(
            relative_parts("src/專案 file.ts", false).unwrap(),
            ["src", "專案 file.ts"]
        );
    }
}
