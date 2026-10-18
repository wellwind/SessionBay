//! Every lookup after the drive root is relative to an owned handle. Never
//! reopen a validated path; a rename cannot redirect subsequent child opens.
use super::*;
use crate::models::{WorkspaceEntry, WorkspaceEntryKind};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    mem::{offset_of, size_of, MaybeUninit},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Prefix},
    ptr,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{RtlNtStatusToDosError, ERROR_NO_MORE_FILES, UNICODE_STRING},
        Storage::FileSystem::*,
        System::IO::IO_STATUS_BLOCK,
    },
};

// GetDriveTypeW's fixed local disk result (Windows SDK winbase.h).
const DRIVE_FIXED: u32 = 3;

fn fs_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "檔案或目錄已不存在，請重新整理".into(),
        io::ErrorKind::PermissionDenied => "沒有權限讀取此檔案或目錄".into(),
        _ => format!("無法安全讀取：不允許符號連結或非一般檔案／目錄（{error}）"),
    }
}

fn inspect(file: &File) -> Result<WorkspaceEntryKind, String> {
    let metadata = file.metadata().map_err(fs_error)?;
    // SAFETY: File owns a live handle throughout this query.
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("只能預覽一般檔案，不支援重新解析點或特殊檔案".into());
    }
    if metadata.is_dir() {
        return Ok(WorkspaceEntryKind::Directory);
    }
    let mut info = MaybeUninit::<FILE_STANDARD_INFO>::uninit();
    // SAFETY: correctly sized/aligned output is read only on successful query.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
    {
        return Err(fs_error(io::Error::last_os_error()));
    }
    // SAFETY: the successful call initialized info.
    let info = unsafe { info.assume_init() };
    if !metadata.is_file() || info.DeletePending {
        return Err("只能預覽一般檔案".into());
    }
    if info.NumberOfLinks != 1 {
        return Err("多重硬連結不支援：無法預覽與其他路徑共用的檔案".into());
    }
    Ok(WorkspaceEntryKind::File)
}

fn open_at(parent: &File, name: &str, directory: bool) -> Result<File, String> {
    if !valid_name(name) {
        return Err("不支援的檔案名稱".into());
    }
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2).map_err(|_| "檔案名稱過長")?;
    let unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &unicode,
        // No case folding: preserve names from case-sensitive Windows directories.
        Attributes: 0,
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: parent and the length-delimited single-component UTF-16 name live
    // through this synchronous call. FILE_OPEN cannot create/truncate. Opening
    // the reparse object itself prevents traversal before the metadata check.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ,
            &attributes,
            &mut status,
            ptr::null(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory { FILE_DIRECTORY_FILE } else { 0 },
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        // SAFETY: pure conversion of an NTSTATUS returned by NtCreateFile.
        return Err(fs_error(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        )));
    }
    // SAFETY: successful synchronous open returned a new uniquely owned handle.
    let file = unsafe { File::from_raw_handle(handle) };
    let kind = inspect(&file)?;
    if directory && kind != WorkspaceEntryKind::Directory {
        return Err("請選擇目錄".into());
    }
    Ok(file)
}

fn open_root(root: &Path) -> Result<File, String> {
    let text = root.to_str().ok_or("專案目錄不是有效的 UTF-8 本機路徑")?;
    if !root.is_absolute() || text.split(['/', '\\']).any(|p| matches!(p, "." | "..")) {
        return Err("專案必須有絕對本機目錄".into());
    }
    let mut components = root.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) if drive.is_ascii_alphabetic() => {
                drive
            }
            _ => return Err("無法預覽遠端或未知路徑".into()),
        },
        _ => return Err("專案必須有絕對本機目錄".into()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err("專案必須有絕對本機目錄".into());
    }
    let drive_path = format!("{}:\\", char::from(drive));
    let wide: Vec<u16> = drive_path.encode_utf16().chain(Some(0)).collect();
    // SAFETY: NUL-terminated drive root. Reject network mappings before opening.
    if unsafe { GetDriveTypeW(wide.as_ptr()) } != DRIVE_FIXED {
        return Err("只能預覽本機固定磁碟上的專案".into());
    }
    let mut directory = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(drive_path)
        .map_err(fs_error)?;
    if inspect(&directory)? != WorkspaceEntryKind::Directory {
        return Err("請選擇目錄".into());
    }
    validate_volume_root(&directory)?;
    for component in components {
        let Component::Normal(name) = component else {
            return Err("不支援的專案路徑".into());
        };
        directory = open_at(&directory, name.to_str().ok_or("專案路徑不是 UTF-8")?, true)?;
    }
    Ok(directory)
}

fn validate_volume_root(directory: &File) -> Result<(), String> {
    // A fixed drive letter can be a SUBST alias into a directory, potentially
    // through unchecked reparse ancestors. Require the opened handle itself to
    // identify a volume root, not a subdirectory reached via DOS name mapping.
    let mut final_path = [0u16; 128];
    // SAFETY: live handle and correctly sized writable UTF-16 buffer.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            directory.as_raw_handle(),
            final_path.as_mut_ptr(),
            final_path.len() as u32,
            VOLUME_NAME_GUID,
        )
    } as usize;
    if length == 0 || length >= final_path.len() {
        return Err("無法驗證本機磁碟根目錄".into());
    }
    let final_path =
        String::from_utf16(&final_path[..length]).map_err(|_| "磁碟根目錄不是 Unicode")?;
    if !final_path.starts_with(r"\\?\Volume{")
        || !final_path.ends_with("}\\")
        || final_path[4..final_path.len() - 1].contains('\\')
    {
        return Err("不支援映射至子目錄的磁碟別名".into());
    }
    Ok(())
}

fn descend(mut directory: File, parts: &[&str]) -> Result<File, String> {
    for part in parts {
        directory = open_at(&directory, part, true)?;
    }
    Ok(directory)
}

pub(super) fn read(
    root: &Path,
    path: &str,
    parts: &[&str],
) -> Result<WorkspaceFilePreview, String> {
    read_from(open_root(root)?, path, parts)
}

fn read_from(directory: File, path: &str, parts: &[&str]) -> Result<WorkspaceFilePreview, String> {
    let (name, parents) = parts.split_last().ok_or("請選擇一般文字檔案")?;
    let directory = descend(directory, parents)?;
    let mut file = open_at(&directory, name, false)?;
    if inspect(&file)? != WorkspaceEntryKind::File {
        return Err("只能預覽一般檔案".into());
    }
    if file.metadata().map_err(fs_error)?.len() > MAX_FILE_BYTES as u64 {
        return Err("檔案過大：文字預覽上限為 256 KiB".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(fs_error)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("檔案過大：文字預覽上限為 256 KiB".into());
    }
    inspect(&file)?;
    let size_bytes = bytes.len();
    let text = String::from_utf8(bytes).map_err(|_| "只能預覽 UTF-8 文字")?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("不支援二進位或含控制字元的檔案，只能預覽 UTF-8 文字".into());
    }
    Ok(WorkspaceFilePreview {
        path: path.to_owned(),
        text,
        size_bytes,
    })
}

pub(super) fn list(
    root: &Path,
    path: &str,
    parts: &[&str],
    offset: usize,
    show_hidden: bool,
) -> Result<WorkspaceFilePage, String> {
    let directory = descend(open_root(root)?, parts)?;
    let mut entries = Vec::new();
    let mut seen = 0usize;
    let mut name_bytes = 0usize;
    enumerate(&directory, |name| {
        seen += 1;
        name_bytes += name.len();
        check_directory_budget(seen, name_bytes)?;
        if show_hidden || !name.starts_with('.') {
            let kind = open_at(&directory, &name, false)
                .and_then(|file| inspect(&file))
                .unwrap_or(WorkspaceEntryKind::Blocked);
            entries.push((name, kind));
        }
        Ok(true)
    })?;
    entries.sort_unstable_by(|a, b| {
        let rank = |kind| u8::from(kind != WorkspaceEntryKind::Directory);
        rank(a.1).cmp(&rank(b.1)).then_with(|| a.0.cmp(&b.0))
    });
    let end = offset.saturating_add(PAGE_SIZE).min(entries.len());
    let next_offset = (end < entries.len()).then_some(end);
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

// Enumerates the owned handle without reopening a pathname. Returning false
// stops the native stream immediately, including within its bounded 64 KiB batch.
fn enumerate(
    directory: &File,
    mut visit: impl FnMut(String) -> Result<bool, String>,
) -> Result<bool, String> {
    // u64 storage provides the alignment required by FILE_ID_BOTH_DIR_INFO.
    let mut buffer = vec![0u64; 8192];
    loop {
        buffer.fill(0);
        // SAFETY: owned directory and aligned 64 KiB writable buffer remain live.
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                FileIdBothDirectoryInfo,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(fs_error(error));
        }
        let mut position = 0usize;
        loop {
            let header = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            let capacity = buffer.len() * 8;
            if position + size_of::<FILE_ID_BOTH_DIR_INFO>() > capacity {
                return Err("目錄資料無效".into());
            }
            // SAFETY: bounds checked above; read_unaligned also handles offsets
            // defensively without relying on filesystem-provided alignment.
            let info = unsafe {
                ptr::read_unaligned(
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(position)
                        .cast::<FILE_ID_BOTH_DIR_INFO>(),
                )
            };
            let length = info.FileNameLength as usize;
            if !length.is_multiple_of(2) || position + header + length > capacity {
                return Err("目錄檔名資料無效".into());
            }
            // SAFETY: checked bounds and even byte length; copy each UTF-16 unit
            // with unaligned reads instead of creating a potentially unaligned slice.
            let units: Vec<u16> = (0..length / 2)
                .map(|i| unsafe {
                    ptr::read_unaligned(
                        buffer
                            .as_ptr()
                            .cast::<u8>()
                            .add(position + header + i * 2)
                            .cast::<u16>(),
                    )
                })
                .collect();
            let name = String::from_utf16(&units).map_err(|_| "目錄含有無效 Unicode 檔名")?;
            if !matches!(name.as_str(), "." | "..") && !visit(name)? {
                return Ok(false);
            }
            let next = info.NextEntryOffset as usize;
            if next == 0 {
                break;
            }
            if next < header + length || next > capacity - position {
                return Err("目錄資料無效".into());
            }
            position += next;
        }
    }
    Ok(true)
}

struct SearchState<'a> {
    query: &'a str,
    result: WorkspaceFileSearch,
    seen: usize,
    started: std::time::Instant,
}

impl SearchState<'_> {
    fn visit(&mut self, directory: File, prefix: &str, depth: usize) -> Result<bool, String> {
        if self.started.elapsed() >= SEARCH_MAX_DURATION {
            self.result.truncated = true;
            return Ok(false);
        }
        enumerate(&directory, |name| {
            if self.seen >= SEARCH_MAX_ENTRIES || self.started.elapsed() >= SEARCH_MAX_DURATION {
                self.result.truncated = true;
                return Ok(false);
            }
            self.seen += 1;
            if !valid_name(&name) {
                return Ok(true);
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if path.len() > MAX_PATH_BYTES {
                self.result.truncated = true;
                return Ok(true);
            }
            // open_at rejects every reparse point and inspect rejects aliases;
            // only metadata is read, never file contents.
            let Ok(child) = open_at(&directory, &name, false) else {
                return Ok(true);
            };
            match inspect(&child) {
                Ok(WorkspaceEntryKind::Directory) => {
                    if [".git", "node_modules", "target", "dist"].contains(&name.as_str()) {
                        return Ok(true);
                    }
                    if depth >= SEARCH_MAX_DEPTH {
                        self.result.truncated = true;
                    } else if !self.visit(child, &path, depth + 1)? {
                        return Ok(false);
                    }
                }
                Ok(WorkspaceEntryKind::File) if path.to_lowercase().contains(self.query) => {
                    if self.result.paths.len() == SEARCH_MAX_RESULTS {
                        self.result.truncated = true;
                        return Ok(false);
                    }
                    self.result.paths.push(path);
                }
                _ => {}
            }
            Ok(true)
        })
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
    };
    state.visit(open_root(root)?, "", 0)?;
    state.result.paths.sort_unstable();
    Ok(state.result)
}

fn check_directory_budget(seen: usize, name_bytes: usize) -> Result<(), String> {
    if seen > MAX_DIRECTORY_ENTRIES || name_bytes > MAX_DIRECTORY_NAME_BYTES {
        return Err("目錄過大：最多可預覽 100,000 個項目及 16 MiB 的檔名".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn directory_budget_boundaries_and_multiple_native_batches() {
        assert!(check_directory_budget(MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_NAME_BYTES).is_ok());
        assert!(check_directory_budget(MAX_DIRECTORY_ENTRIES + 1, 0).is_err());
        assert!(check_directory_budget(1, MAX_DIRECTORY_NAME_BYTES + 1).is_err());
        let temp = tempfile::tempdir().unwrap();
        for i in 0..450 {
            fs::write(
                temp.path().join(format!("{i:03}-{}.txt", "x".repeat(160))),
                "text",
            )
            .unwrap();
        }
        let mut names = Vec::new();
        let mut offset = 0;
        loop {
            let page = list(temp.path(), "", &[], offset, true).unwrap();
            names.extend(page.entries.into_iter().map(|entry| entry.name));
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(names.len(), 450);
        names.dedup();
        assert_eq!(names.len(), 450);
        assert!(names[0].starts_with("000-"));
        assert!(names[449].starts_with("449-"));
    }

    #[test]
    fn pinned_root_and_parent_cannot_be_replaced_while_reading() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), "inside").unwrap();
        let pinned = open_root(&root).unwrap();
        assert!(validate_volume_root(&pinned).is_err());
        assert!(fs::rename(&root, temp.path().join("old")).is_err());
        let child = open_at(&pinned, "sub", true).unwrap();
        assert!(fs::rename(root.join("sub"), root.join("old-sub")).is_err());
        assert_eq!(
            read_from(child, "file.txt", &["file.txt"]).unwrap().text,
            "inside"
        );
        assert_eq!(
            read_from(pinned, "sub/file.txt", &["sub", "file.txt"])
                .unwrap()
                .text,
            "inside"
        );
        fs::rename(&root, temp.path().join("old")).unwrap();
    }

    #[test]
    fn live_file_handle_prevents_replacement_and_concurrent_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("text.txt");
        fs::write(&path, "unchanged synthetic text").unwrap();
        let root = open_root(temp.path()).unwrap();
        let file = open_at(&root, "text.txt", false).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::rename(&path, temp.path().join("old.txt")).is_err());
        drop(file);
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        assert!(read_from(root, "text.txt", &["text.txt"]).is_err());
        drop(writer);
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "unchanged synthetic text"
        );
    }

    #[test]
    fn rejects_junctions_at_leaf_parent_root_and_root_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "synthetic outside").unwrap();
        // Junctions need no symlink privilege. Only synthetic fixture paths are
        // passed as separate arguments; no change to OS security settings.
        let link = root.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "junction fixture must run, never silently skip"
        );
        assert!(read(&root, "junction/secret.txt", &["junction", "secret.txt"]).is_err());
        assert!(list(&root, "junction", &["junction"], 0, true).is_err());
        assert!(read(&link, "secret.txt", &["secret.txt"]).is_err());
        fs::create_dir(outside.join("nested")).unwrap();
        assert!(list(&link.join("nested"), "", &[], 0, true).is_err());
        let page = list(&root, "", &[], 0, true).unwrap();
        assert_eq!(page.entries[0].kind, WorkspaceEntryKind::Blocked);
        // Remove the junction itself, never recurse through it during cleanup.
        fs::remove_dir(&link).unwrap();
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "synthetic outside"
        );
    }

    #[test]
    fn rejects_file_symlinks_if_creation_is_available() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("target.txt"), "synthetic").unwrap();
        let link = temp.path().join("link.txt");
        match std::os::windows::fs::symlink_file(temp.path().join("target.txt"), &link) {
            Ok(()) => {
                assert!(read(temp.path(), "link.txt", &["link.txt"]).is_err());
                fs::remove_file(link).unwrap();
            }
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("SKIPPED file symlink fixture: privilege unavailable; junction coverage remains mandatory");
            }
            Err(error) => panic!("symlink fixture failed: {error}"),
        }
    }

    #[test]
    fn rejects_ambiguous_and_remote_roots_before_opening() {
        for root in [
            r"C:relative",
            r"\\host\share",
            r"\\?\UNC\host\share",
            r"\\.\pipe\name",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
            r"C:\a\..\b",
            r"C:\a\.\b",
            r"C:\NUL",
            r"C:\a:stream",
        ] {
            assert!(open_root(Path::new(root)).is_err(), "accepted {root}");
        }
    }
}
