//! User-triggered image staging. Never accepts an input/output filesystem path.
//! Pending files are deleted on discard; retained files survive UI/runtime teardown.
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::{
    collections::HashMap,
    fmt,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

/// Captured at launch, never inferred from mutable current settings.
/// Identifies the direct configured CLI route, not the live foreground prompt.
pub fn supports_launch(kind: &str, spec: &crate::runtime::LaunchSpec) -> bool {
    if !matches!(kind, "codex" | "claude" | "grok" | "opencode") {
        return false;
    }
    let name = Path::new(&spec.executable)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    (name == kind || name == format!("{kind}.exe"))
        && !["SSH_CONNECTION", "SSH_CLIENT", "WSL_DISTRO_NAME"]
            .iter()
            .any(|key| spec.env.contains_key(*key))
}

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
const MAX_PENDING: usize = 4;
const MAX_PENDING_BYTES: usize = 20 * 1024 * 1024;
const MAX_STORED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STORED_FILES: usize = 2048;
const MAX_PIXELS: u64 = 16_000_000;

// Bound this Vec during deserialization. Tauri has already allocated the raw JSON body.
#[derive(Debug)]
pub struct ImageChunk(pub Vec<u8>);
impl<'de> Deserialize<'de> for ImageChunk {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ChunkVisitor;
        impl<'de> Visitor<'de> for ChunkVisitor {
            type Value = ImageChunk;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "at most {MAX_CHUNK_BYTES} bytes")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut bytes =
                    Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX_CHUNK_BYTES));
                while let Some(byte) = seq.next_element::<u8>()? {
                    if bytes.len() == MAX_CHUNK_BYTES {
                        return Err(de::Error::custom("Image chunk exceeds 64 KiB"));
                    }
                    bytes.push(byte);
                }
                Ok(ImageChunk(bytes))
            }
        }
        deserializer.deserialize_seq(ChunkVisitor)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImage {
    pub id: String,
    pub path: String,
}
struct Pending {
    runtime: String,
    expected: usize,
    received: usize,
    format: ImageFormat,
    file: NamedTempFile,
    verified: bool,
}
pub struct ImageStaging {
    directory: PathBuf,
    directory_handle: File,
    _lock: File,
    pending: HashMap<String, Pending>,
}

#[cfg(windows)]
use crate::windows_security;

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
            return Err("圖片暫存位置必須是目前使用者專用的真實目錄。".into());
        }
    }
    #[cfg(windows)]
    windows_security::private_directory(directory).map_err(|e| e.to_string())?;
    Ok(())
}

impl ImageStaging {
    pub fn open(app_directory: &Path) -> Result<Self, String> {
        let directory = app_directory.join("image-input-v1");
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
        format!("圖片暫存已達 {limit} 上限。保留位置：{}。請先結束使用這些圖片的 Agent；僅手動移除確定不再用於接續對話的圖片。不要刪除 staging.lock。", self.directory.display())
    }
    fn check_directory(&self) -> Result<(), String> {
        let current = open_directory(&self.directory)?;
        if !same_file(&self.directory_handle, &current)? {
            return Err("圖片暫存目錄已被替換。".into());
        }
        Ok(())
    }
    pub fn begin(&mut self, runtime: &str, mime: &str, size: usize) -> Result<String, String> {
        if size == 0 || size > MAX_IMAGE_BYTES {
            return Err("每張圖片須介於 1 byte 與 10 MiB。".into());
        }
        let (format, suffix) = match mime {
            "image/png" => (ImageFormat::Png, ".png"),
            "image/jpeg" => (ImageFormat::Jpeg, ".jpg"),
            _ => return Err("僅支援 PNG 與 JPEG 圖片。".into()),
        };
        if self.pending.len() >= MAX_PENDING
            || self.pending.values().map(|p| p.expected).sum::<usize>() + size > MAX_PENDING_BYTES
        {
            return Err("待處理圖片已達 4 張／20 MiB 上限。".into());
        }
        self.check_directory()?;
        let mut stored = 0u64;
        for (index, entry) in fs::read_dir(&self.directory)
            .map_err(|e| e.to_string())?
            .enumerate()
        {
            if index + 1 >= MAX_STORED_FILES {
                return Err(self.quota_error("數量"));
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                return Err("圖片暫存目錄含非預期項目；未寫入圖片。".into());
            }
            stored = stored.saturating_add(metadata.len());
        }
        let reserved: u64 = self
            .pending
            .values()
            .map(|p| (p.expected - p.received) as u64)
            .sum();
        if stored.saturating_add(reserved).saturating_add(size as u64) > MAX_STORED_BYTES {
            return Err(self.quota_error("512 MiB"));
        }
        let file = tempfile::Builder::new()
            .prefix("image-")
            .suffix(suffix)
            .tempfile_in(&self.directory)
            .map_err(|e| e.to_string())?;
        safe_path(file.path())?;
        let id = Uuid::new_v4().to_string();
        let pending = Pending {
            runtime: runtime.into(),
            expected: size,
            received: 0,
            format,
            file,
            verified: false,
        };
        verify_pending_path(&pending)?; // Check DACL before receiving bytes, too.
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
            .ok_or("找不到此工作階段的待處理圖片。")?;
        if p.verified
            || bytes.is_empty()
            || bytes.len() > MAX_CHUNK_BYTES
            || offset != p.received
            || bytes.len() > p.expected - p.received
        {
            return Err("圖片分段大小或順序無效。".into());
        }
        p.file.write_all(bytes).map_err(|e| e.to_string())?;
        p.received += bytes.len();
        Ok(())
    }
    pub fn finish(&mut self, runtime: &str, id: &str) -> Result<StagedImage, String> {
        self.check_directory()?;
        let p = self
            .pending
            .get_mut(id)
            .filter(|p| p.runtime == runtime)
            .ok_or("找不到此工作階段的待處理圖片。")?;
        if p.received != p.expected {
            return Err("圖片尚未接收完整。".into());
        }
        p.file.flush().map_err(|e| e.to_string())?;
        p.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        validate_image(p.file.as_file_mut(), p.format)?;
        verify_pending_path(p)?;
        p.verified = true;
        Ok(StagedImage {
            id: id.into(),
            path: safe_path(p.file.path())?,
        })
    }
    // Retain BEFORE terminal insertion: an uncertain write must never delete agent input.
    pub fn retain(&mut self, runtime: &str, id: &str) -> Result<(), String> {
        let p = self
            .pending
            .get(id)
            .filter(|p| p.runtime == runtime)
            .ok_or("找不到此工作階段的待處理圖片。")?;
        if !p.verified {
            return Err("圖片尚未通過驗證。".into());
        }
        verify_pending_path(p)?;
        self.check_directory()?;
        let p = self.pending.remove(id).ok_or("找不到圖片。")?;
        p.file.as_file().sync_all().map_err(|e| e.to_string())?;
        p.file.keep().map_err(|e| e.error.to_string())?;
        Ok(())
    }
    pub fn discard(&mut self, runtime: &str, id: &str) -> Result<(), String> {
        if let Some(p) = self.pending.get(id) {
            if p.runtime != runtime {
                return Err("圖片屬於另一個工作階段。".into());
            }
        }
        if let Some(pending) = self.pending.remove(id) {
            if self.check_directory().is_err() || verify_pending_path(&pending).is_err() {
                let _ = pending.file.keep(); // Do not unlink a substituted path.
                return Err("圖片暫存位置已變更，未刪除不明檔案。".into());
            }
            pending.file.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Drop for ImageStaging {
    fn drop(&mut self) {
        let directory_valid = self.check_directory().is_ok();
        for (_, pending) in self.pending.drain() {
            if !directory_valid || verify_pending_path(&pending).is_err() {
                let _ = pending.file.keep();
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
        return Err("圖片暫存鎖不是一般檔案。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let m = file.metadata().map_err(|e| e.to_string())?;
        if m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o077 != 0
        {
            return Err("圖片暫存鎖權限不安全。".into());
        }
    }
    #[cfg(windows)]
    windows_security::verify_file(&file).map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "另一個 Session Bay 程序正在使用圖片暫存，請在原視窗操作。")?;
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
        return Err("圖片暫存位置不是目錄。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("圖片暫存目錄權限不安全。".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("圖片暫存位置不能是連結。".into());
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
        return Err("圖片暫存檔案已被替換。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let m = current.metadata().map_err(|e| e.to_string())?;
        if m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o077 != 0
        {
            return Err("圖片暫存檔案權限不安全。".into());
        }
    }
    #[cfg(windows)]
    windows_security::verify_file(&current).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn safe_path(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("圖片暫存路徑不是有效 UTF-8。")?;
    if value.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\'' | '"' | '`' | '$' | ';' | '|' | '&' | '<' | '>' | '(' | ')'
            )
    }) {
        return Err("圖片暫存路徑含不安全字元，無法插入終端。".into());
    }
    Ok(value.to_owned())
}

fn validate_image(file: &mut File, expected: ImageFormat) -> Result<(), String> {
    let mut reader = ImageReader::new(BufReader::new(&mut *file))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if reader.format() != Some(expected) {
        return Err("圖片內容與宣告格式不符。".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|e| format!("無法讀取圖片：{e}"))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("圖片不得超過 1600 萬像素。".into());
    }
    if decoder.total_bytes() > 64 * 1024 * 1024 {
        return Err("圖片解碼記憶體超過 64 MiB。".into());
    }
    image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("圖片損壞或超過解碼限制：{e}"))?;
    if expected == ImageFormat::Png {
        // Reject APNG rather than silently attaching only its first frame.
        file.seek(SeekFrom::Start(8)).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        loop {
            let mut header = [0u8; 8];
            file.read_exact(&mut header).map_err(|e| e.to_string())?;
            if &header[4..] == b"acTL" {
                return Err("暫不支援動態 PNG。".into());
            }
            let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
            let position = file.stream_position().map_err(|e| e.to_string())?;
            if position.saturating_add(len).saturating_add(4) > size {
                return Err("PNG 區塊不完整。".into());
            }
            file.seek(SeekFrom::Current((len + 4) as i64))
                .map_err(|e| e.to_string())?;
            if &header[4..] == b"IEND" {
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn picture(format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut out, format)
            .unwrap();
        out.into_inner()
    }
    fn stage(store: &mut ImageStaging, bytes: &[u8], mime: &str) -> String {
        let id = store.begin("runtime", mime, bytes.len()).unwrap();
        for (index, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            store
                .append("runtime", &id, index * MAX_CHUNK_BYTES, chunk)
                .unwrap();
        }
        id
    }
    #[test]
    fn staging_lock_prevents_concurrent_process_quotas_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let store = ImageStaging::open(temp.path()).unwrap();
        assert!(ImageStaging::open(temp.path()).is_err());
        drop(store);
        assert!(ImageStaging::open(temp.path()).is_ok());
    }
    #[test]
    fn entry_quota_reserves_the_new_file_and_counts_the_lock() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        for index in 0..MAX_STORED_FILES - 2 {
            File::create(store.directory.join(format!("synthetic-{index}.png"))).unwrap();
        }
        let id = store.begin("runtime", "image/png", 1).unwrap();
        assert_eq!(
            fs::read_dir(&store.directory).unwrap().count(),
            MAX_STORED_FILES
        );
        assert!(store
            .begin("runtime", "image/png", 1)
            .unwrap_err()
            .contains("數量"));
        store.discard("runtime", &id).unwrap();
        assert!(store.begin("runtime", "image/png", 1).is_ok());
    }
    #[test]
    fn persistent_disk_quota_is_recounted_and_explains_safe_manual_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let store = ImageStaging::open(temp.path()).unwrap();
        let path = store.directory.join("synthetic-retained.png");
        let file = File::create(&path).unwrap();
        // Sparse synthetic allocation exercises accounting without real image/user data.
        file.set_len(MAX_STORED_BYTES).unwrap();
        drop(file);
        drop(store);
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let error = store.begin("runtime", "image/png", 1).unwrap_err();
        assert!(error.contains("512 MiB"));
        assert!(error.contains(store.directory.to_str().unwrap()));
        assert!(error.contains("staging.lock"));
        assert!(path.exists());
    }
    #[test]
    fn launch_capability_excludes_shell_and_remote_wrappers() {
        let mut spec = crate::runtime::LaunchSpec {
            executable: "codex".into(),
            args: vec![],
            cwd: PathBuf::from("/synthetic"),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
            pane_id: "pane".into(),
        };
        for kind in ["codex", "claude", "grok", "opencode"] {
            spec.executable = kind.into();
            assert!(supports_launch(kind, &spec));
            spec.executable = format!("{kind}.exe");
            assert!(supports_launch(kind, &spec));
        }
        for executable in ["ssh", "wsl.exe", "wrapper.sh", "node"] {
            spec.executable = executable.into();
            assert!(!supports_launch("codex", &spec));
        }
        spec.executable = "codex".into();
        assert!(!supports_launch("shell", &spec));
        assert!(!supports_launch("antigravity", &spec));
        spec.env
            .insert("WSL_DISTRO_NAME".into(), "synthetic".into());
        assert!(!supports_launch("codex", &spec));
    }
    #[test]
    fn png_jpeg_remain_after_retain_and_store_reopen() {
        let temp = tempfile::tempdir().unwrap();
        for (format, mime) in [
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Jpeg, "image/jpeg"),
        ] {
            let mut store = ImageStaging::open(temp.path()).unwrap();
            let bytes = picture(format);
            let id = stage(&mut store, &bytes, mime);
            let staged = store.finish("runtime", &id).unwrap();
            assert!(Path::new(&staged.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("image-"));
            assert!(store.retain("another-runtime", &id).is_err());
            store.retain("runtime", &id).unwrap();
            store.discard("runtime", &id).unwrap();
            drop(store);
            let _reopened = ImageStaging::open(temp.path()).unwrap();
            assert_eq!(fs::read(staged.path).unwrap(), bytes);
        }
    }
    #[test]
    fn cancellation_removes_only_pending_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let bytes = picture(ImageFormat::Png);
        let id = stage(&mut store, &bytes, "image/png");
        let staged = store.finish("runtime", &id).unwrap();
        assert!(store.discard("other", &id).is_err());
        assert!(Path::new(&staged.path).exists());
        store.discard("runtime", &id).unwrap();
        assert!(!Path::new(&staged.path).exists());
        assert!(store.discard("runtime", "../../other.png").is_ok());
    }
    #[test]
    fn rejects_empty_oversize_mime_spoof_truncation_and_out_of_order_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        assert!(store.begin("r", "image/png", 0).is_err());
        assert!(store.begin("r", "image/png", MAX_IMAGE_BYTES + 1).is_err());
        for mime in ["image/svg+xml", "image/gif", "../../file.png", "text/html"] {
            assert!(store.begin("r", mime, 10).is_err());
        }
        let id = store.begin("runtime", "image/png", 20).unwrap();
        assert!(store.append("runtime", &id, 1, &[1]).is_err());
        assert!(store.append("other", &id, 0, &[1]).is_err());
        assert!(store.append("runtime", &id, 0, &[]).is_err());
        assert!(store.append("runtime", &id, 0, &[1; 21]).is_err());
        assert!(store.finish("runtime", &id).is_err());
        assert!(store.retain("runtime", &id).is_err());
        store.discard("runtime", &id).unwrap();
        for (bytes, mime) in [
            (picture(ImageFormat::Png), "image/jpeg"),
            (b"<script>bad</script>".to_vec(), "image/png"),
            (picture(ImageFormat::Png)[..20].to_vec(), "image/png"),
        ] {
            let id = stage(&mut store, &bytes, mime);
            assert!(store.finish("runtime", &id).is_err());
            store.discard("runtime", &id).unwrap();
        }
    }
    #[test]
    fn enforces_pending_count_total_and_chunk_deserialization_limits() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let first = store
            .begin("runtime", "image/png", MAX_IMAGE_BYTES)
            .unwrap();
        store
            .begin("runtime", "image/png", MAX_IMAGE_BYTES)
            .unwrap();
        assert!(store.begin("runtime", "image/png", 1).is_err());
        store.discard("runtime", &first).unwrap();
        for _ in 0..3 {
            store.begin("runtime", "image/png", 1).unwrap();
        }
        assert!(store.begin("runtime", "image/png", 1).is_err());
        let json = serde_json::to_string(&vec![1u8; MAX_CHUNK_BYTES]).unwrap();
        assert_eq!(
            serde_json::from_str::<ImageChunk>(&json).unwrap().0.len(),
            MAX_CHUNK_BYTES
        );
        let json = serde_json::to_string(&vec![1u8; MAX_CHUNK_BYTES + 1]).unwrap();
        assert!(serde_json::from_str::<ImageChunk>(&json).is_err());
        for invalid in ["[-1]", "[256]", "[1.5]", "\"abc\""] {
            assert!(serde_json::from_str::<ImageChunk>(invalid).is_err());
        }
    }
    #[test]
    fn rejects_dimensions_before_allocating_full_raster() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let id = stage(&mut store, bytes.get_ref(), "image/png");
        assert!(store.finish("runtime", &id).is_err());
    }
    #[test]
    fn rejects_control_and_shell_metacharacters_in_staging_root() {
        for path in [
            "/tmp/\nimage.png",
            "/tmp/a\u{1b}.png",
            "/tmp/$(id)/a.png",
            "/tmp/a'b.png",
            "/tmp/a\"b.png",
            "/tmp/a;id.png",
        ] {
            assert!(safe_path(Path::new(path)).is_err());
        }
        assert!(safe_path(Path::new("/tmp/專案 alpha/image.png")).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_root_replaced_directory_and_file_hardlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root = temp.path().join("image-input-v1");
        symlink(other.path(), &root).unwrap();
        assert!(ImageStaging::open(temp.path()).is_err());
        fs::remove_file(&root).unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, &picture(ImageFormat::Png), "image/png");
        let path = store.pending[&id].file.path().to_path_buf();
        fs::hard_link(&path, other.path().join("alias.png")).unwrap();
        assert!(store.finish("runtime", &id).is_err());
        fs::remove_file(other.path().join("alias.png")).unwrap();
        store.finish("runtime", &id).unwrap();
        fs::rename(&root, temp.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(store.begin("runtime", "image/png", 1).is_err());
        assert!(store.retain("runtime", &id).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_final_file_symlink_before_retain() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let mut store = ImageStaging::open(temp.path()).unwrap();
        let id = stage(&mut store, &picture(ImageFormat::Png), "image/png");
        let staged = store.finish("runtime", &id).unwrap();
        let other = temp.path().join("untouched");
        fs::write(&other, b"untouched").unwrap();
        fs::remove_file(&staged.path).unwrap();
        symlink(&other, &staged.path).unwrap();
        assert!(store.retain("runtime", &id).is_err());
        assert_eq!(fs::read(other).unwrap(), b"untouched");
    }
}
