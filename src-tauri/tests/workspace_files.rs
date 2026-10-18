//! Synthetic read-only workspace fixtures; never reads real user projects/history.
use sessionbay_lib::service::Service;
use std::{fs, path::PathBuf, sync::Arc};

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    service: Arc<Service>,
    project_id: String,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        // macOS's temporary directory can use /var, a platform symlink. Fixture
        // setup picks its real path; production preview never canonicalizes.
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("synthetic project");
        fs::create_dir(&root).unwrap();
        let service = Service::open(base.join("app")).unwrap();
        let project = service
            .catalog
            .add_project(root.to_str().unwrap(), None)
            .unwrap();
        Self {
            _temp: temp,
            base,
            root,
            service,
            project_id: project.id,
        }
    }

    fn insert_project(&self, id: &str, path: Option<&str>, launch: Option<&str>) {
        rusqlite::Connection::open(self.base.join("app/catalog.sqlite"))
            .unwrap()
            .execute(
                "INSERT INTO projects(id,name,path,launch_path) VALUES(?1,'synthetic',?2,?3)",
                rusqlite::params![id, path, launch],
            )
            .unwrap();
    }
}

#[test]
fn project_identity_is_required_and_null_original_path_cannot_use_launch_override() {
    let fixture = Fixture::new();
    for unknown in ["", "temporary", "project-not-found", "../synthetic project"] {
        assert!(fixture
            .service
            .list_workspace_files(unknown, "", 0, false)
            .unwrap_err()
            .contains("找不到專案"));
        assert!(fixture
            .service
            .read_workspace_file(unknown, "file.txt")
            .is_err());
    }
    fixture.insert_project("unclassified", None, fixture.root.to_str());
    assert!(fixture
        .service
        .list_workspace_files("unclassified", "", 0, false)
        .unwrap_err()
        .contains("沒有本機目錄"));
    assert!(fixture
        .service
        .read_workspace_file("unclassified", "file.txt")
        .unwrap_err()
        .contains("沒有本機目錄"));
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod supported {
    use super::*;
    use sessionbay_lib::models::WorkspaceEntryKind;
    #[cfg(unix)]
    use std::{ffi::CString, os::unix::fs::symlink, time::Instant};

    #[test]
    fn lazy_pages_are_directory_first_sorted_bounded_and_hidden_is_opt_in() {
        let fixture = Fixture::new();
        for name in ["z-folder", "a-folder", "node_modules"] {
            fs::create_dir(fixture.root.join(name)).unwrap();
            fs::write(fixture.root.join(name).join("nested.txt"), "nested").unwrap();
        }
        for index in (0..205).rev() {
            fs::write(fixture.root.join(format!("file-{index:03}.txt")), "text").unwrap();
        }
        fs::write(fixture.root.join(".hidden"), "hidden synthetic").unwrap();
        fs::create_dir(fixture.root.join(".hidden-dir")).unwrap();
        let first = fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 0, false)
            .unwrap();
        assert_eq!(first.entries.len(), 200);
        assert_eq!(first.next_offset, Some(200));
        assert_eq!(
            first.entries[..3]
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["a-folder", "node_modules", "z-folder"]
        );
        assert!(first.entries[..3]
            .iter()
            .all(|entry| entry.kind == WorkspaceEntryKind::Directory));
        assert_eq!(first.entries[3].name, "file-000.txt");
        assert_eq!(first.entries[199].name, "file-196.txt");
        assert!(!first.entries.iter().any(|entry| entry.path.contains('/')));
        let second = fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 200, false)
            .unwrap();
        assert_eq!(second.entries.len(), 8);
        assert_eq!(second.entries[0].name, "file-197.txt");
        assert_eq!(second.next_offset, None);
        let hidden = fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 0, true)
            .unwrap();
        assert_eq!(hidden.entries[0].name, ".hidden-dir");
        assert!(hidden.entries.iter().any(|entry| entry.name == ".hidden"));
        let nested = fixture
            .service
            .list_workspace_files(&fixture.project_id, "node_modules", 0, false)
            .unwrap();
        assert_eq!(nested.entries.len(), 1);
        assert_eq!(nested.entries[0].path, "node_modules/nested.txt");
        assert!(fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 100_001, false)
            .is_err());
        assert!(fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 999, false)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn reads_utf8_bytes_literally_without_writes_and_accepts_exact_size_limit() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join("資料夾")).unwrap();
        let text = "\u{feff}繁體中文\n<script>alert('synthetic')</script>\r\n\tline";
        let path = "資料夾/文字檔.txt";
        fs::write(fixture.root.join(path), text).unwrap();
        let preview = fixture
            .service
            .read_workspace_file(&fixture.project_id, path)
            .unwrap();
        assert_eq!(preview.path, path);
        assert_eq!(preview.text, text);
        assert_eq!(preview.size_bytes, text.len());
        assert_eq!(fs::read_to_string(fixture.root.join(path)).unwrap(), text);
        fs::write(fixture.root.join("empty.txt"), "").unwrap();
        assert_eq!(
            fixture
                .service
                .read_workspace_file(&fixture.project_id, "empty.txt")
                .unwrap()
                .size_bytes,
            0
        );
        fs::write(fixture.root.join("limit.txt"), vec![b'a'; 256 * 1024]).unwrap();
        assert_eq!(
            fixture
                .service
                .read_workspace_file(&fixture.project_id, "limit.txt")
                .unwrap()
                .size_bytes,
            256 * 1024
        );
    }

    #[test]
    fn rejects_binary_control_non_utf8_oversize_directory_and_missing_file() {
        let fixture = Fixture::new();
        for (name, bytes, expected) in [
            ("binary.bin", b"text\0binary".as_slice(), "二進位"),
            ("escape.txt", b"\x1b[31m".as_slice(), "控制字元"),
            ("c1.txt", "\u{0085}".as_bytes(), "控制字元"),
            ("invalid.txt", b"\xff\xfe".as_slice(), "UTF-8"),
        ] {
            fs::write(fixture.root.join(name), bytes).unwrap();
            assert!(fixture
                .service
                .read_workspace_file(&fixture.project_id, name)
                .unwrap_err()
                .contains(expected));
        }
        fs::write(fixture.root.join("large.txt"), vec![b'x'; 256 * 1024 + 1]).unwrap();
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "large.txt")
            .unwrap_err()
            .contains("256 KiB"));
        fs::create_dir(fixture.root.join("dir")).unwrap();
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "dir")
            .unwrap_err()
            .contains("一般檔案"));
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "missing.txt")
            .unwrap_err()
            .contains("不存在"));
    }

    #[test]
    fn rejects_multiple_hardlinks_without_reading_or_modifying_source() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside-source.txt");
        let original = b"synthetic outside inode content";
        fs::write(&outside, original).unwrap();
        fs::hard_link(&outside, fixture.root.join("alias.txt")).unwrap();
        // Ordinary directories have multiple links and must remain browseable.
        fs::create_dir(fixture.root.join("nested")).unwrap();
        fs::create_dir(fixture.root.join("nested/child")).unwrap();
        let page = fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 0, false)
            .unwrap();
        assert_eq!(
            page.entries
                .iter()
                .find(|entry| entry.name == "alias.txt")
                .unwrap()
                .kind,
            WorkspaceEntryKind::Blocked
        );
        assert_eq!(
            page.entries
                .iter()
                .find(|entry| entry.name == "nested")
                .unwrap()
                .kind,
            WorkspaceEntryKind::Directory
        );
        assert!(fixture
            .service
            .list_workspace_files(&fixture.project_id, "nested", 0, false)
            .is_ok());
        let error = fixture
            .service
            .read_workspace_file(&fixture.project_id, "alias.txt")
            .unwrap_err();
        assert!(error.contains("多重硬連結不支援"));
        assert!(!error.contains("synthetic outside inode content"));
        assert_eq!(fs::read(&outside).unwrap(), original);
        assert_eq!(fs::read(fixture.root.join("alias.txt")).unwrap(), original);
    }

    #[test]
    #[cfg(unix)]
    fn rejects_outside_links_in_root_links_fifo_and_link_components() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside synthetic").unwrap();
        fs::write(fixture.root.join("plain.txt"), "inside synthetic").unwrap();
        symlink(
            outside.join("secret.txt"),
            fixture.root.join("outside-link"),
        )
        .unwrap();
        symlink(
            fixture.root.join("plain.txt"),
            fixture.root.join("inside-link"),
        )
        .unwrap();
        symlink(&outside, fixture.root.join("dir-link")).unwrap();
        let fifo_path = CString::new(fixture.root.join("pipe").to_str().unwrap()).unwrap();
        // SAFETY: synthetic fixture path is NUL-terminated; mode is owner-only.
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        let page = fixture
            .service
            .list_workspace_files(&fixture.project_id, "", 0, false)
            .unwrap();
        for name in ["outside-link", "inside-link", "dir-link", "pipe"] {
            assert_eq!(
                page.entries
                    .iter()
                    .find(|entry| entry.name == name)
                    .unwrap()
                    .kind,
                WorkspaceEntryKind::Blocked
            );
            let start = Instant::now();
            assert!(fixture
                .service
                .read_workspace_file(&fixture.project_id, name)
                .is_err());
            assert!(start.elapsed().as_secs() < 2, "special file read blocked");
        }
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "dir-link/secret.txt")
            .is_err());
        assert!(fixture
            .service
            .list_workspace_files(&fixture.project_id, "dir-link", 0, false)
            .is_err());
        let root_link = fixture.base.join("root-link");
        symlink(&fixture.root, &root_link).unwrap();
        fixture.insert_project("linked-root", root_link.to_str(), None);
        assert!(fixture
            .service
            .list_workspace_files("linked-root", "", 0, false)
            .is_err());
        assert!(fixture
            .service
            .read_workspace_file("linked-root", "plain.txt")
            .is_err());
        let parent_link = fixture.base.join("parent-link");
        symlink(&fixture.base, &parent_link).unwrap();
        fixture.insert_project(
            "linked-ancestor",
            parent_link.join("synthetic project").to_str(),
            None,
        );
        assert!(fixture
            .service
            .list_workspace_files("linked-ancestor", "", 0, false)
            .is_err());
    }

    #[test]
    fn launch_override_never_changes_authorized_root_and_nonlocal_roots_fail() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file.txt"), "outside synthetic").unwrap();
        fs::write(fixture.root.join("file.txt"), "original root").unwrap();
        fixture
            .service
            .catalog
            .update_project(&fixture.project_id, None, outside.to_str(), None, None)
            .unwrap();
        assert_eq!(
            fixture
                .service
                .read_workspace_file(&fixture.project_id, "file.txt")
                .unwrap()
                .text,
            "original root"
        );
        fs::remove_dir_all(&fixture.root).unwrap();
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "file.txt")
            .is_err());
        for (index, path) in [
            "relative/project",
            #[cfg(not(windows))]
            "C:\\project",
            #[cfg(not(windows))]
            "C:/project",
            "\\\\server\\share",
            "//server/share",
            "ssh://host/project",
            "file:///tmp/project",
        ]
        .iter()
        .enumerate()
        {
            let id = format!("nonlocal-{index}");
            fixture.insert_project(&id, Some(path), None);
            assert!(fixture
                .service
                .list_workspace_files(&id, "", 0, false)
                .is_err());
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[test]
fn unsupported_platform_fails_closed_before_filesystem_access() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("file.txt"), "synthetic").unwrap();
    assert!(fixture
        .service
        .list_workspace_files(&fixture.project_id, "", 0, false)
        .unwrap_err()
        .contains("尚未支援安全檔案預覽"));
    assert!(fixture
        .service
        .read_workspace_file(&fixture.project_id, "file.txt")
        .unwrap_err()
        .contains("尚未支援安全檔案預覽"));
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod bounded_reads {
    use super::*;
    use sessionbay_lib::models::WorkspaceFileKind;
    use std::{
        fs::{File, FileTimes, OpenOptions},
        io::Write,
        time::{Duration, SystemTime},
    };

    const CHUNK_BYTES: usize = 256 * 1024;
    const SAMPLE_BYTES: usize = 64 * 1024;

    #[test]
    fn reads_large_utf8_in_bounded_chunks_without_legacy_limit() {
        let fixture = Fixture::new();
        let text = "繁體中文🦀\r\n\t".repeat(40_000);
        fs::write(fixture.root.join("large.txt"), &text).unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "large.txt")
            .unwrap();
        assert_eq!(info.path, "large.txt");
        assert_eq!(info.size_bytes, text.len() as u64);
        assert_eq!(info.kind, WorkspaceFileKind::Text);
        assert_eq!(info.version.len(), 64);
        assert!(info.version.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            info,
            fixture
                .service
                .inspect_workspace_file(&fixture.project_id, "large.txt")
                .unwrap()
        );
        let mut bytes = Vec::new();
        loop {
            let chunk = fixture
                .service
                .read_workspace_file_chunk(
                    &fixture.project_id,
                    "large.txt",
                    &info.version,
                    bytes.len() as u64,
                    CHUNK_BYTES,
                )
                .unwrap();
            assert!(!chunk.bytes.is_empty());
            assert!(chunk.bytes.len() <= CHUNK_BYTES);
            bytes.extend(chunk.bytes);
            assert_eq!(chunk.eof, bytes.len() == text.len());
            if chunk.eof {
                break;
            }
        }
        assert_eq!(bytes, text.as_bytes());
        assert_eq!(fs::read(fixture.root.join("large.txt")).unwrap(), bytes);
        // Retain the previous API contract for older callers.
        assert!(fixture
            .service
            .read_workspace_file(&fixture.project_id, "large.txt")
            .unwrap_err()
            .contains("256 KiB"));
    }

    #[test]
    fn raw_chunks_preserve_every_split_inside_multibyte_characters_and_bom() {
        let fixture = Fixture::new();
        let text = "\u{feff}aé中🦀\r\n";
        fs::write(fixture.root.join("utf8.txt"), text).unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "utf8.txt")
            .unwrap();
        for max_bytes in 1..=7 {
            let mut bytes = Vec::new();
            loop {
                let chunk = fixture
                    .service
                    .read_workspace_file_chunk(
                        &fixture.project_id,
                        "utf8.txt",
                        &info.version,
                        bytes.len() as u64,
                        max_bytes,
                    )
                    .unwrap();
                assert!(chunk.bytes.len() <= max_bytes);
                bytes.extend(chunk.bytes);
                if chunk.eof {
                    break;
                }
            }
            assert_eq!(String::from_utf8(bytes).unwrap(), text);
        }
    }

    #[test]
    fn preflight_tolerates_only_nonfinal_incomplete_utf8_and_is_sample_bounded() {
        let fixture = Fixture::new();
        for (index, prefix_length) in (SAMPLE_BYTES - 3..SAMPLE_BYTES).enumerate() {
            let mut bytes = vec![b'a'; prefix_length];
            bytes.extend("🦀".as_bytes());
            let name = format!("boundary-{index}.txt");
            fs::write(fixture.root.join(&name), &bytes).unwrap();
            let info = fixture
                .service
                .inspect_workspace_file(&fixture.project_id, &name)
                .unwrap();
            assert_eq!(info.kind, WorkspaceFileKind::Text);
            bytes.truncate(SAMPLE_BYTES);
            fs::write(fixture.root.join(&name), &bytes).unwrap();
            assert_eq!(
                fixture
                    .service
                    .inspect_workspace_file(&fixture.project_id, &name)
                    .unwrap()
                    .kind,
                WorkspaceFileKind::Binary,
                "a final partial UTF-8 character must not be accepted"
            );
        }
        let mut bytes = vec![b'a'; SAMPLE_BYTES];
        bytes.extend([0, 255]);
        fs::write(fixture.root.join("later-binary.txt"), &bytes).unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "later-binary.txt")
            .unwrap();
        // Classification is explicitly a bounded hint; streaming text callers
        // still validate all later content. The raw-byte API does not decode it.
        assert_eq!(info.kind, WorkspaceFileKind::Text);
        assert_eq!(
            fixture
                .service
                .read_workspace_file_chunk(
                    &fixture.project_id,
                    "later-binary.txt",
                    &info.version,
                    SAMPLE_BYTES as u64,
                    CHUNK_BYTES,
                )
                .unwrap()
                .bytes,
            [0, 255]
        );
    }

    #[test]
    fn classifies_binary_and_control_bytes_without_blocking_raw_reads() {
        let fixture = Fixture::new();
        for (name, bytes) in [
            ("binary-nul.bin", b"before\0after".as_slice()),
            ("escape.bin", b"\x1b[31m".as_slice()),
            ("c1.bin", "\u{0085}".as_bytes()),
            ("invalid.bin", b"\xff\xfe".as_slice()),
            ("incomplete.bin", b"\xf0\x9f".as_slice()),
        ] {
            fs::write(fixture.root.join(name), bytes).unwrap();
            let info = fixture
                .service
                .inspect_workspace_file(&fixture.project_id, name)
                .unwrap();
            assert_eq!(info.kind, WorkspaceFileKind::Binary, "{name}");
            let chunk = fixture
                .service
                .read_workspace_file_chunk(&fixture.project_id, name, &info.version, 0, CHUNK_BYTES)
                .unwrap();
            assert_eq!(chunk.bytes, bytes);
            assert!(chunk.eof);
        }
    }

    #[test]
    fn validates_chunk_budget_offset_eof_and_empty_files() {
        let fixture = Fixture::new();
        for (name, bytes) in [
            ("empty.txt", b"".as_slice()),
            ("short.txt", b"abc".as_slice()),
        ] {
            fs::write(fixture.root.join(name), bytes).unwrap();
            let info = fixture
                .service
                .inspect_workspace_file(&fixture.project_id, name)
                .unwrap();
            assert_eq!(info.kind, WorkspaceFileKind::Text);
            for max_bytes in [0, CHUNK_BYTES + 1, usize::MAX] {
                assert!(fixture
                    .service
                    .read_workspace_file_chunk(
                        &fixture.project_id,
                        name,
                        &info.version,
                        0,
                        max_bytes,
                    )
                    .unwrap_err()
                    .contains("256 KiB"));
            }
            for offset in [bytes.len() as u64 + 1, u64::MAX] {
                assert!(fixture
                    .service
                    .read_workspace_file_chunk(&fixture.project_id, name, &info.version, offset, 1,)
                    .unwrap_err()
                    .contains("讀取位置"));
            }
            let eof = fixture
                .service
                .read_workspace_file_chunk(
                    &fixture.project_id,
                    name,
                    &info.version,
                    bytes.len() as u64,
                    CHUNK_BYTES,
                )
                .unwrap();
            assert!(eof.eof);
            assert!(eof.bytes.is_empty());
            for version in ["", "fake", &"g".repeat(64), &"0".repeat(64)] {
                assert!(fixture
                    .service
                    .read_workspace_file_chunk(&fixture.project_id, name, version, 0, 1)
                    .unwrap_err()
                    .contains("已變更"));
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn handles_sparse_sizes_and_offsets_beyond_four_gib_without_full_read() {
        use std::io::{Seek, SeekFrom};
        let fixture = Fixture::new();
        let path = fixture.root.join("sparse.bin");
        let mut file = File::create(&path).unwrap();
        let marker_offset = 4 * 1024 * 1024 * 1024 + 123;
        file.seek(SeekFrom::Start(marker_offset)).unwrap();
        file.write_all(b"tail").unwrap();
        drop(file);
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "sparse.bin")
            .unwrap();
        assert_eq!(info.size_bytes, marker_offset + 4);
        assert_eq!(info.kind, WorkspaceFileKind::Binary);
        let chunk = fixture
            .service
            .read_workspace_file_chunk(
                &fixture.project_id,
                "sparse.bin",
                &info.version,
                marker_offset,
                CHUNK_BYTES,
            )
            .unwrap();
        assert_eq!(chunk.bytes, b"tail");
        assert!(chunk.eof);
    }

    #[test]
    fn rejects_modified_truncated_grown_or_replaced_versions() {
        let fixture = Fixture::new();
        let path = fixture.root.join("version.txt");
        for change in ["modified", "truncated", "grown", "replaced"] {
            fs::write(&path, b"initial").unwrap();
            let info = fixture
                .service
                .inspect_workspace_file(&fixture.project_id, "version.txt")
                .unwrap();
            let previous_modified = fs::metadata(&path).unwrap().modified().unwrap();
            match change {
                "modified" => {
                    fs::write(&path, b"changed").unwrap();
                    File::options()
                        .write(true)
                        .open(&path)
                        .unwrap()
                        .set_times(
                            FileTimes::new()
                                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(42)),
                        )
                        .unwrap();
                }
                "truncated" => File::create(&path).unwrap().set_len(1).unwrap(),
                "grown" => {
                    OpenOptions::new()
                        .append(true)
                        .open(&path)
                        .unwrap()
                        .write_all(b"more")
                        .unwrap();
                }
                "replaced" => {
                    fs::rename(&path, fixture.root.join("old-version.txt")).unwrap();
                    fs::write(&path, b"initial").unwrap();
                    File::options()
                        .write(true)
                        .open(&path)
                        .unwrap()
                        .set_times(FileTimes::new().set_modified(previous_modified))
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                fixture
                    .service
                    .read_workspace_file_chunk(
                        &fixture.project_id,
                        "version.txt",
                        &info.version,
                        0,
                        CHUNK_BYTES,
                    )
                    .unwrap_err()
                    .contains("已變更"),
                "{change}"
            );
            let changed = fixture
                .service
                .inspect_workspace_file(&fixture.project_id, "version.txt")
                .unwrap();
            assert_ne!(info.version, changed.version, "{change}");
        }
    }

    #[test]
    fn requires_catalog_identity_original_root_and_safe_relative_paths() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file.txt"), "inside").unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "file.txt")
            .unwrap();
        fixture.insert_project("unclassified-bounded", None, fixture.root.to_str());
        for project in ["", "unknown", "unclassified-bounded"] {
            assert!(fixture
                .service
                .inspect_workspace_file(project, "file.txt")
                .is_err());
            assert!(fixture
                .service
                .read_workspace_file_chunk(project, "file.txt", &info.version, 0, 1)
                .is_err());
        }
        for path in [
            "",
            "..",
            "../file.txt",
            "/file.txt",
            "a/../file.txt",
            "a//b",
            "a\\b",
            "file:stream",
            "CON",
            "trailing.",
            "file\0.txt",
        ] {
            assert!(
                fixture
                    .service
                    .inspect_workspace_file(&fixture.project_id, path)
                    .is_err(),
                "{path:?}"
            );
            assert!(
                fixture
                    .service
                    .read_workspace_file_chunk(&fixture.project_id, path, &info.version, 0, 1)
                    .is_err(),
                "{path:?}"
            );
        }
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file.txt"), "outside").unwrap();
        fixture
            .service
            .catalog
            .update_project(&fixture.project_id, None, outside.to_str(), None, None)
            .unwrap();
        let chunk = fixture
            .service
            .read_workspace_file_chunk(
                &fixture.project_id,
                "file.txt",
                &info.version,
                0,
                CHUNK_BYTES,
            )
            .unwrap();
        assert_eq!(chunk.bytes, b"inside");
        for path in ["missing.txt", "."] {
            assert!(fixture
                .service
                .inspect_workspace_file(&fixture.project_id, path)
                .is_err());
        }
        fs::create_dir(fixture.root.join("directory")).unwrap();
        assert!(fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "directory")
            .is_err());
    }

    #[test]
    fn hardlink_added_between_calls_is_rejected_before_content_is_returned() {
        let fixture = Fixture::new();
        let path = fixture.root.join("file.txt");
        fs::write(&path, "synthetic private bytes").unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "file.txt")
            .unwrap();
        fs::hard_link(&path, fixture.base.join("outside-alias.txt")).unwrap();
        assert!(fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "file.txt")
            .unwrap_err()
            .contains("多重硬連結"));
        assert!(fixture
            .service
            .read_workspace_file_chunk(
                &fixture.project_id,
                "file.txt",
                &info.version,
                0,
                CHUNK_BYTES
            )
            .unwrap_err()
            .contains("多重硬連結"));
        assert_eq!(fs::read(&path).unwrap(), b"synthetic private bytes");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_links_roots_intermediates_and_fifo_fail_closed() {
        use std::{ffi::CString, os::unix::fs::symlink, time::Instant};
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file.txt"), "outside must not leak").unwrap();
        fs::write(fixture.root.join("file.txt"), "inside").unwrap();
        let info = fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "file.txt")
            .unwrap();
        fs::rename(
            fixture.root.join("file.txt"),
            fixture.root.join("original.txt"),
        )
        .unwrap();
        symlink(outside.join("file.txt"), fixture.root.join("file.txt")).unwrap();
        symlink(&outside, fixture.root.join("linked-parent")).unwrap();
        let fifo = CString::new(fixture.root.join("fifo").to_str().unwrap()).unwrap();
        // SAFETY: owner-only synthetic fixture path, NUL-terminated above.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        for name in ["file.txt", "linked-parent/file.txt", "fifo"] {
            let start = Instant::now();
            assert!(fixture
                .service
                .inspect_workspace_file(&fixture.project_id, name)
                .is_err());
            assert!(fixture
                .service
                .read_workspace_file_chunk(&fixture.project_id, name, &info.version, 0, 1)
                .is_err());
            assert!(start.elapsed() < Duration::from_secs(2));
        }
        fs::rename(&fixture.root, fixture.base.join("original-root")).unwrap();
        symlink(&outside, &fixture.root).unwrap();
        assert!(fixture
            .service
            .inspect_workspace_file(&fixture.project_id, "file.txt")
            .is_err());
        assert!(fixture
            .service
            .read_workspace_file_chunk(&fixture.project_id, "file.txt", &info.version, 0, 1)
            .is_err());
    }
}
