//! Read-only, catalog-scoped workspace preview. Never canonicalize and then open
//! an untrusted path: every component is resolved relative to an owned directory
//! descriptor, with symlink following disabled in the actual open operation.
use crate::models::{WorkspaceFilePage, WorkspaceFilePreview};
use std::path::Path;

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const PAGE_SIZE: usize = 200;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_PATH_BYTES: usize = 4096;
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
        fs::File,
        io::{self, Read},
        mem::MaybeUninit,
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::Component,
        ptr::NonNull,
    };

    fn fs_error(error: io::Error) -> String {
        match error.kind() {
            io::ErrorKind::NotFound => "檔案或目錄已不存在，請重新整理".into(),
            io::ErrorKind::PermissionDenied => "沒有權限讀取此檔案或目錄".into(),
            _ => format!("無法安全讀取：不允許符號連結或非一般檔案／目錄（{error}）"),
        }
    }

    fn c_name(name: &[u8]) -> Result<CString, String> {
        CString::new(name).map_err(|_| "檔案路徑不可包含空字元".into())
    }

    fn open_at(parent: RawFd, name: &CStr, directory: bool) -> Result<File, String> {
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        // SAFETY: parent is an owned live directory descriptor (or AT_FDCWD for
        // the literal filesystem root); name is NUL-terminated. No creation.
        let descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(fs_error(io::Error::last_os_error()));
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
        let mut directory = open_at(libc::AT_FDCWD, c"/", true)?;
        for component in root.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    directory = open_at(directory.as_raw_fd(), &c_name(name.as_bytes())?, true)?;
                }
                _ => return Err("專案目錄含有不支援的路徑成分".into()),
            }
        }
        Ok(directory)
    }

    fn descend(mut directory: File, parts: &[&str]) -> Result<File, String> {
        for part in parts {
            directory = open_at(directory.as_raw_fd(), &c_name(part.as_bytes())?, true)?;
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
                    Err(fs_error(error))
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
                    Err(fs_error(io::Error::from_raw_os_error(code)))
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

    fn read_from(
        directory: File,
        path: &str,
        parts: &[&str],
    ) -> Result<WorkspaceFilePreview, String> {
        let (name, parents) = parts.split_last().ok_or("請選擇一般文字檔案")?;
        let directory = descend(directory, parents)?;
        let name = c_name(name.as_bytes())?;
        let before = stat_at(directory.as_raw_fd(), &name).map_err(fs_error)?;
        if before.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err("只能預覽一般檔案，不支援符號連結、目錄或特殊檔案".into());
        }
        // O_NONBLOCK avoids blocking if a regular file is replaced by a FIFO
        // between fstatat and openat. O_NOFOLLOW prevents a symlink replacement.
        let mut file = open_at(directory.as_raw_fd(), &name, false)?;
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
