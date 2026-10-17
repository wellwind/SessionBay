//! User-triggered opaque file staging. Files are never decoded or executed. Never accepts an input/output filesystem path.
//! Pending files are deleted on discard; retained files survive UI/runtime teardown.
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::{
    collections::HashMap,
    fmt,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
const MAX_PENDING: usize = 4;
const MAX_PENDING_BYTES: usize = 20 * 1024 * 1024;
const MAX_STORED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STORED_FILES: usize = 2048;

// Bound this Vec during deserialization. Tauri has already allocated the raw JSON body.
#[derive(Debug)]
pub struct FileChunk(pub Vec<u8>);
impl<'de> Deserialize<'de> for FileChunk {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ChunkVisitor;
        impl<'de> Visitor<'de> for ChunkVisitor {
            type Value = FileChunk;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "at most {MAX_CHUNK_BYTES} bytes")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut bytes =
                    Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX_CHUNK_BYTES));
                while let Some(byte) = seq.next_element::<u8>()? {
                    if bytes.len() == MAX_CHUNK_BYTES {
                        return Err(de::Error::custom("File chunk exceeds 64 KiB"));
                    }
                    bytes.push(byte);
                }
                Ok(FileChunk(bytes))
            }
        }
        deserializer.deserialize_seq(ChunkVisitor)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub id: String,
    pub path: String,
    pub original_name: String,
    pub name: String,
}
struct Pending {
    runtime: String,
    expected: usize,
    received: usize,
    original_name: String,
    name: String,
    directory: PathBuf,
    directory_handle: File,
    file: NamedTempFile,
    verified: bool,
}
pub struct FileStaging {
    directory: PathBuf,
    directory_handle: File,
    _lock: File,
    pending: HashMap<String, Pending>,
}

#[cfg(windows)]
#[allow(dead_code)]
#[path = "broker/windows_security.rs"]
mod windows_security;

fn private_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        match fs::DirBuilder::new().mode(0o700).create(directory) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.to_string()),
        }
        let m = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !m.is_dir()
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o077 != 0
        {
            return Err("檔案暫存位置必須是目前使用者專用的真實目錄。".into());
        }
    }
    #[cfg(windows)]
    windows_security::private_directory(directory).map_err(|e| e.to_string())?;
    Ok(())
}

impl FileStaging {
    pub fn open(app_directory: &Path) -> Result<Self, String> {
        let directory = app_directory.join("file-input-v1");
        private_directory(&directory)?;
        let directory = fs::canonicalize(directory).map_err(|e| e.to_string())?;
        // Path text eventually enters a terminal. Never emit control bytes or shell metacharacters.
        safe_path(&directory)?;
        let directory_handle = open_directory(&directory)?;
        let lock = lock_store(&directory)?;
        Ok(Self {
            _lock: lock,
            directory,
            directory_handle,
            pending: HashMap::new(),
        })
    }
    fn quota_error(&self, limit: &str) -> String {
        format!("檔案暫存已達 {limit} 上限。保留位置：{}。請先結束使用這些檔案的 Agent；僅手動移除確定不再用於接續對話的檔案。不要刪除 staging.lock。", self.directory.display())
    }
    fn check_directory(&self) -> Result<(), String> {
        let current = open_directory(&self.directory)?;
        if !same_file(&self.directory_handle, &current)? {
            return Err("檔案暫存目錄已被替換。".into());
        }
        Ok(())
    }
    pub fn begin(&mut self, runtime: &str, name: &str, size: usize) -> Result<String, String> {
        if size > MAX_FILE_BYTES {
            return Err("每個檔案不得超過 10 MiB。".into());
        }
        let sanitized = sanitize_name(name)?;
        if self.pending.len() >= MAX_PENDING
            || self.pending.values().map(|p| p.expected).sum::<usize>() + size > MAX_PENDING_BYTES
        {
            return Err("待處理檔案已達 4 個／20 MiB 上限。".into());
        }
        self.check_directory()?;
        let mut stored = 0u64;
        let mut count = 0;
        for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == "staging.lock" {
                continue;
            }
            count += 1;
            if count >= MAX_STORED_FILES {
                return Err(self.quota_error("2048 個檔案目錄"));
            }
            let directory = entry.path();
            let _handle = open_directory(&directory)?;
            for (index, child) in fs::read_dir(&directory)
                .map_err(|e| e.to_string())?
                .enumerate()
            {
                if index > 0 {
                    return Err("檔案暫存子目錄含非預期的多個檔案；未寫入檔案。".into());
                }
                let metadata = fs::symlink_metadata(child.map_err(|e| e.to_string())?.path())
                    .map_err(|e| e.to_string())?;
                if !metadata.is_file() {
                    return Err("檔案暫存目錄含非預期項目；未寫入檔案。".into());
                }
                stored = stored.saturating_add(metadata.len());
            }
        }
        let reserved: u64 = self
            .pending
            .values()
            .map(|p| (p.expected - p.received) as u64)
            .sum();
        if stored.saturating_add(reserved).saturating_add(size as u64) > MAX_STORED_BYTES {
            return Err(self.quota_error("512 MiB"));
        }
        let id = Uuid::new_v4().to_string();
        let mut builder = tempfile::Builder::new();
        builder.prefix("upload-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let directory = builder
            .tempdir_in(&self.directory)
            .map_err(|e| e.to_string())?
            .keep();
        private_directory(&directory)?;
        let directory_handle = open_directory(&directory)?;
        let result = (|| -> Result<Pending, String> {
            let path = directory.join(&sanitized);
            safe_path(&path)?;
            let mut options = fs::OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path).map_err(|e| e.to_string())?;
            let file = NamedTempFile::from_parts(
                file,
                tempfile::TempPath::try_from_path(path).map_err(|e| e.to_string())?,
            );
            let pending = Pending {
                runtime: runtime.into(),
                expected: size,
                received: 0,
                original_name: name.into(),
                name: sanitized,
                directory: directory.clone(),
                directory_handle: directory_handle.try_clone().map_err(|e| e.to_string())?,
                file,
                verified: false,
            };
            // Never let NamedTempFile drop unlink a substituted path after a failed identity check.
            if let Err(error) = verify_pending_path(&pending) {
                let _ = pending.file.keep();
                return Err(error);
            }
            Ok(pending)
        })();
        let pending = match result {
            Ok(pending) => pending,
            Err(error) => {
                // Remove only a still-owned empty directory; never recursively clean unknown content.
                if self.check_directory().is_ok()
                    && open_directory(&directory).is_ok_and(|current| {
                        same_file(&directory_handle, &current).unwrap_or(false)
                    })
                {
                    let _ = fs::remove_dir(&directory);
                }
                return Err(error);
            }
        };
        self.pending.insert(id.clone(), pending);
        Ok(id)
    }
    pub fn append(
        &mut self,
        runtime: &str,
        id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let p = self
            .pending
            .get_mut(id)
            .filter(|p| p.runtime == runtime)
            .ok_or("找不到此工作階段的待處理檔案。")?;
        if p.verified
            || bytes.is_empty()
            || bytes.len() > MAX_CHUNK_BYTES
            || offset != p.received
            || bytes.len() > p.expected - p.received
        {
            return Err("檔案分段大小或順序無效。".into());
        }
        p.file.write_all(bytes).map_err(|e| e.to_string())?;
        p.received += bytes.len();
        Ok(())
    }
    pub fn finish(&mut self, runtime: &str, id: &str) -> Result<StagedFile, String> {
        self.check_directory()?;
        let p = self
            .pending
            .get_mut(id)
            .filter(|p| p.runtime == runtime)
            .ok_or("找不到此工作階段的待處理檔案。")?;
        if p.received != p.expected {
            return Err("檔案尚未接收完整。".into());
        }
        p.file.flush().map_err(|e| e.to_string())?;
        verify_pending_path(p)?;
        p.verified = true;
        Ok(StagedFile {
            id: id.into(),
            path: safe_path(p.file.path())?,
            original_name: p.original_name.clone(),
            name: p.name.clone(),
        })
    }
    // Retain BEFORE terminal insertion: an uncertain write must never delete agent input.
    pub fn retain(&mut self, runtime: &str, id: &str) -> Result<(), String> {
        let p = self
            .pending
            .get(id)
            .filter(|p| p.runtime == runtime)
            .ok_or("找不到此工作階段的待處理檔案。")?;
        if !p.verified {
            return Err("檔案尚未通過驗證。".into());
        }
        verify_pending_path(p)?;
        self.check_directory()?;
        let p = self.pending.remove(id).ok_or("找不到檔案。")?;
        p.file.as_file().sync_all().map_err(|e| e.to_string())?;
        p.file.keep().map_err(|e| e.error.to_string())?;
        Ok(())
    }
    pub fn discard(&mut self, runtime: &str, id: &str) -> Result<(), String> {
        if let Some(p) = self.pending.get(id) {
            if p.runtime != runtime {
                return Err("檔案屬於另一個工作階段。".into());
            }
        }
        if let Some(pending) = self.pending.remove(id) {
            if self.check_directory().is_err() || verify_pending_path(&pending).is_err() {
                let _ = pending.file.keep(); // Do not unlink a substituted path.
                return Err("檔案暫存位置已變更，未刪除不明檔案。".into());
            }
            pending.file.close().map_err(|e| e.to_string())?;
            fs::remove_dir(pending.directory).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Drop for FileStaging {
    fn drop(&mut self) {
        let directory_valid = self.check_directory().is_ok();
        for (_, pending) in self.pending.drain() {
            if !directory_valid || verify_pending_path(&pending).is_err() {
                let _ = pending.file.keep();
            } else {
                let directory = pending.directory;
                if pending.file.close().is_ok() {
                    let _ = fs::remove_dir(directory);
                }
            }
        }
    }
}
fn lock_store(directory: &Path) -> Result<File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(directory.join("staging.lock"))
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("檔案暫存鎖不是一般檔案。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let m = file.metadata().map_err(|e| e.to_string())?;
        if m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o077 != 0
        {
            return Err("檔案暫存鎖權限不安全。".into());
        }
    }
    #[cfg(windows)]
    windows_security::verify_file(&file).map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "另一個 Session Bay 程序正在使用檔案暫存，請在原視窗操作。")?;
    Ok(file)
}

fn open_directory(path: &Path) -> Result<File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
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
        return Err("檔案暫存位置不是目錄。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("檔案暫存目錄權限不安全。".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("檔案暫存位置不能是連結。".into());
        }
        windows_security::verify_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(file)
}
fn same_file(a: &File, b: &File) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let a = a.metadata().map_err(|e| e.to_string())?;
        let b = b.metadata().map_err(|e| e.to_string())?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(windows)]
    {
        Ok(
            crate::windows_fs::identity_from_file(a).map_err(|e| e.to_string())?
                == crate::windows_fs::identity_from_file(b).map_err(|e| e.to_string())?,
        )
    }
}
fn verify_pending_path(p: &Pending) -> Result<(), String> {
    if !same_file(&p.directory_handle, &open_directory(&p.directory)?)? {
        return Err("檔案暫存子目錄已被替換。".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
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
    let current = options.open(p.file.path()).map_err(|e| e.to_string())?;
    if !current.metadata().map_err(|e| e.to_string())?.is_file()
        || !same_file(p.file.as_file(), &current)?
    {
        return Err("檔案暫存檔案已被替換。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let m = current.metadata().map_err(|e| e.to_string())?;
        if m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o077 != 0
        {
            return Err("檔案暫存檔案權限不安全。".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        windows_security::verify_file(&current).map_err(|e| e.to_string())?;
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: current owns a live file handle, and info is a correctly sized output buffer.
        if unsafe { GetFileInformationByHandle(current.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: the successful call initialized the structure.
        if unsafe { info.assume_init() }.nNumberOfLinks != 1 {
            return Err("檔案暫存檔案不能有其他硬連結。".into());
        }
    }
    Ok(())
}

pub fn safe_path(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("檔案暫存路徑不是有效 UTF-8。")?;
    if value.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\'' | '"' | '`' | '$' | ';' | '|' | '&' | '<' | '>' | '(' | ')'
            )
    }) {
        return Err("檔案暫存路徑含不安全字元，無法插入終端。".into());
    }
    Ok(value.to_owned())
}
/// Preserve readable Unicode and extension, replacing only unsafe cross-platform characters.
/// Bounded bytes also keep percent-encoded terminal references within practical CLI limits.
fn sanitize_name(original: &str) -> Result<String, String> {
    if original.len() > 4096 {
        return Err("檔名不得超過 4096 bytes。".into());
    }
    let mut name: String = original.chars().map(|c| {
        if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\'' | '`' | '$' | ';' | '&' | '(' | ')')
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}') { '_' } else { c }
    }).collect();
    name = name.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() || name == "." || name == ".." {
        name = "file".into();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|tail| {
            matches!(
                tail,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        name.insert(0, '_');
    }
    if name.len() > 120 {
        let extension = name
            .rsplit_once('.')
            .filter(|(stem, ext)| !stem.is_empty() && ext.len() <= 32)
            .map(|(_, ext)| format!(".{ext}"));
        let budget = 120 - extension.as_ref().map_or(0, String::len);
        let mut cut = budget;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
        if let Some(extension) = extension {
            name.push_str(&extension);
        }
    }
    Ok(name)
}

pub fn check_runtime(record: &crate::broker::RuntimeRecord) -> Result<(), String> {
    if record.info.state != "running" || record.info.exit_code.is_some() {
        return Err("檔案目標工作階段已停止。".into());
    }
    if !matches!(
        record.kind.as_str(),
        "codex" | "claude" | "grok" | "opencode"
    ) {
        return Err("此 Agent 類型尚未支援本機檔案參照；Shell 與 Antigravity 不支援。".into());
    }
    match record.file_input {
        Some(true) => Ok(()),
        Some(false) => Err("此工作階段的啟動路由不是已驗證的直接本機 Agent；Shell、自訂、SSH／WSL 包裝程式不支援檔案參照。".into()),
        None if record.image_input => Ok(()),
        None => Err("此工作階段缺少可核對的本機啟動證明，尚未插入。請保留目前 Agent；可另開新的直接本機 Agent 分頁使用檔案輸入。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stage(store: &mut FileStaging, name: &str, bytes: &[u8]) -> String {
        let id = store.begin("runtime", name, bytes.len()).unwrap();
        for (i, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            store
                .append("runtime", &id, i * MAX_CHUNK_BYTES, chunk)
                .unwrap();
        }
        id
    }
    #[test]
    fn opaque_files_preserve_names_and_bytes_without_decode_or_execution() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        for (name, bytes) in [
            ("報告 final.pdf", b"not a pdf".as_slice()),
            ("drawing.svg", b"<svg><script>doNotRun()</script></svg>"),
            ("archive.zip", b"PK\x00\xff"),
            ("empty.txt", b""),
            ("photo.png", b"opaque not decoded"),
        ] {
            let id = stage(&mut store, name, bytes);
            let result = store.finish("runtime", &id).unwrap();
            assert_eq!(result.name, name);
            assert_eq!(result.original_name, name);
            assert_eq!(Path::new(&result.path).file_name().unwrap(), name);
            store.retain("runtime", &id).unwrap();
            assert_eq!(fs::read(result.path).unwrap(), bytes);
        }
    }
    #[test]
    fn duplicate_names_are_isolated_and_retained_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        let a = stage(&mut store, "same.txt", b"first");
        let b = stage(&mut store, "same.txt", b"second");
        let a_result = store.finish("runtime", &a).unwrap();
        let b_result = store.finish("runtime", &b).unwrap();
        assert_ne!(a_result.path, b_result.path);
        store.retain("runtime", &a).unwrap();
        store.retain("runtime", &b).unwrap();
        drop(store);
        let _store = FileStaging::open(temp.path()).unwrap();
        assert_eq!(fs::read(a_result.path).unwrap(), b"first");
        assert_eq!(fs::read(b_result.path).unwrap(), b"second");
    }
    #[test]
    fn names_are_safe_cross_platform_and_cleanup_is_disclosed() {
        for (raw, safe) in [
            ("../a.txt", ".._a.txt"),
            ("C:\\bad\\a.txt", "C__bad_a.txt"),
            ("CON.txt", "_CON.txt"),
            ("lpt¹.log", "_lpt¹.log"),
            ("a\n\x1b.txt", "a__.txt"),
            ("a\u{202e}.svg", "a_.svg"),
            ("a$(id);'\".txt", "a__id____.txt"),
            ("trailing. ", "trailing"),
            ("", "file"),
            ("..", "file"),
        ] {
            assert_eq!(sanitize_name(raw).unwrap(), safe, "{raw:?}");
        }
        let original = format!("{}.pdf", "漢".repeat(100));
        let safe = sanitize_name(&original).unwrap();
        assert!(safe.len() <= 120 && safe.ends_with(".pdf"));
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, "a\n.txt", b"data");
        let result = store.finish("runtime", &id).unwrap();
        assert_eq!(result.original_name, "a\n.txt");
        assert_eq!(result.name, "a_.txt");
        assert!(sanitize_name(&"a".repeat(4097)).is_err());
    }
    #[test]
    fn ownership_order_quota_and_cleanup_hold() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        assert!(FileStaging::open(temp.path()).is_err());
        assert!(store.begin("runtime", "big", MAX_FILE_BYTES + 1).is_err());
        let a = store.begin("runtime", "a", MAX_FILE_BYTES).unwrap();
        let b = store.begin("runtime", "b", MAX_FILE_BYTES).unwrap();
        assert!(store.begin("runtime", "c", 1).is_err());
        assert!(store.append("other", &a, 0, b"a").is_err());
        assert!(store.append("runtime", &a, 1, b"a").is_err());
        assert!(store.finish("runtime", &a).is_err());
        assert!(store.retain("runtime", &a).is_err());
        assert!(store.discard("other", &a).is_err());
        store.discard("runtime", &a).unwrap();
        store.discard("runtime", &b).unwrap();
        for _ in 0..4 {
            store.begin("runtime", "empty", 0).unwrap();
        }
        assert!(store.begin("runtime", "empty", 0).is_err());
        drop(store);
        let mut store = FileStaging::open(temp.path()).unwrap();
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
        let id = stage(&mut store, "huge", b"x");
        let result = store.finish("runtime", &id).unwrap();
        store.retain("runtime", &id).unwrap();
        File::options()
            .write(true)
            .open(&result.path)
            .unwrap()
            .set_len(MAX_STORED_BYTES)
            .unwrap();
        assert!(store
            .begin("runtime", "extra", 1)
            .unwrap_err()
            .contains("512 MiB"));
        assert!(Path::new(&result.path).exists());
    }
    #[test]
    fn entry_quota_counts_empty_upload_directories() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        for i in 0..MAX_STORED_FILES {
            private_directory(&store.directory.join(format!("upload-{i}"))).unwrap();
        }
        assert!(store.begin("runtime", "a", 0).unwrap_err().contains("2048"));
    }
    #[test]
    fn discard_never_recursively_deletes_unexpected_upload_contents() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, "file.txt", b"data");
        let result = store.finish("runtime", &id).unwrap();
        let unknown = Path::new(&result.path)
            .parent()
            .unwrap()
            .join("unexpected.txt");
        fs::write(&unknown, b"keep this").unwrap();
        assert!(store
            .begin("runtime", "next", 0)
            .unwrap_err()
            .contains("多個檔案"));
        assert!(store.discard("runtime", &id).is_err());
        assert_eq!(fs::read(&unknown).unwrap(), b"keep this");
        assert!(!Path::new(&result.path).exists());
    }
    #[test]
    fn file_chunk_deserialization_is_bounded() {
        let json = serde_json::to_string(&vec![0u8; MAX_CHUNK_BYTES]).unwrap();
        assert_eq!(
            serde_json::from_str::<FileChunk>(&json).unwrap().0.len(),
            MAX_CHUNK_BYTES
        );
        let json = serde_json::to_string(&vec![0u8; MAX_CHUNK_BYTES + 1]).unwrap();
        assert!(serde_json::from_str::<FileChunk>(&json).is_err());
    }
    #[test]
    fn rejects_hardlinks_before_finish_and_retain() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, "file.txt", b"data");
        let path = store.pending[&id].file.path().to_path_buf();
        let alias = temp.path().join("alias.txt");
        fs::hard_link(&path, &alias).unwrap();
        assert!(store.finish("runtime", &id).is_err());
        fs::remove_file(&alias).unwrap();
        store.finish("runtime", &id).unwrap();
        fs::hard_link(&path, &alias).unwrap();
        assert!(store.retain("runtime", &id).is_err());
        fs::remove_file(&alias).unwrap();
        store.discard("runtime", &id).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn private_permissions_and_symlink_hardlink_directory_replacement_guards() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let mut store = FileStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, "file.txt", b"bytes");
        let result = store.finish("runtime", &id).unwrap();
        let path = Path::new(&result.path);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let other = temp.path().join("other");
        fs::hard_link(path, &other).unwrap();
        assert!(store.retain("runtime", &id).is_err());
        fs::remove_file(&other).unwrap();
        let old_dir = path.parent().unwrap();
        let moved = temp.path().join("moved");
        fs::rename(old_dir, &moved).unwrap();
        private_directory(old_dir).unwrap();
        fs::write(path, b"do not remove").unwrap();
        assert!(store.retain("runtime", &id).is_err());
        assert!(store.discard("runtime", &id).is_err());
        assert_eq!(fs::read(path).unwrap(), b"do not remove");
        let id = stage(&mut store, "next.txt", b"data");
        let result = store.finish("runtime", &id).unwrap();
        fs::remove_file(&result.path).unwrap();
        symlink(&other, &result.path).unwrap();
        assert!(store.retain("runtime", &id).is_err());
    }
}
