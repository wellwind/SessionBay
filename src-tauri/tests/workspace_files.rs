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
#[test]
fn recursive_search_finds_unloaded_hidden_paths_without_reading_contents() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("unloaded/deeper/.hidden")).unwrap();
    fs::write(f.root.join("unloaded/deeper/.hidden/Needle.bin"), [0, 255]).unwrap();
    fs::write(f.root.join("content-only.txt"), "Needle").unwrap();
    for excluded in [".git", "node_modules", "target", "dist"] {
        fs::create_dir_all(f.root.join(excluded)).unwrap();
        fs::write(f.root.join(excluded).join("Needle.txt"), "excluded").unwrap();
    }
    let result = f
        .service
        .search_workspace_files(&f.project_id, "DEEPER/.hidden/needle")
        .unwrap();
    assert_eq!(result.paths, ["unloaded/deeper/.hidden/Needle.bin"]);
    assert!(!result.truncated);
    let result = f
        .service
        .search_workspace_files(&f.project_id, "needle")
        .unwrap();
    assert_eq!(result.paths, ["unloaded/deeper/.hidden/Needle.bin"]);
    assert!(f
        .service
        .read_workspace_file(&f.project_id, &result.paths[0])
        .is_err());
    assert!(f
        .service
        .search_workspace_files("unknown", "needle")
        .is_err());
    assert!(f
        .service
        .search_workspace_files(&f.project_id, "../")
        .unwrap()
        .paths
        .is_empty());
    assert!(f
        .service
        .search_workspace_files(&f.project_id, " \t ")
        .is_err());
    assert!(f
        .service
        .search_workspace_files(&f.project_id, "   ")
        .unwrap()
        .paths
        .is_empty());
    assert!(f
        .service
        .search_workspace_files(&f.project_id, &"x".repeat(257))
        .is_err());
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn recursive_search_caps_results_and_reports_depth_cutoff() {
    let f = Fixture::new();
    for i in 0..50 {
        fs::write(f.root.join(format!("match-{i}.txt")), "").unwrap();
    }
    let exact = f
        .service
        .search_workspace_files(&f.project_id, "match-")
        .unwrap();
    assert_eq!(exact.paths.len(), 50);
    assert!(!exact.truncated);
    fs::write(f.root.join("match-50.txt"), "").unwrap();
    let result = f
        .service
        .search_workspace_files(&f.project_id, "match-")
        .unwrap();
    assert_eq!(result.paths.len(), 50);
    assert!(result.truncated);
    let deep = f.root.join(vec!["sub"; 33].join("/"));
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("beyond-depth.txt"), "").unwrap();
    let result = f
        .service
        .search_workspace_files(&f.project_id, "beyond-depth")
        .unwrap();
    assert!(result.paths.is_empty());
    assert!(result.truncated);
}

#[cfg(unix)]
#[test]
fn recursive_search_never_follows_outside_links_or_hard_link_aliases() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "private").unwrap();
    symlink(&outside, f.root.join("linked-folder")).unwrap();
    symlink(outside.join("secret.txt"), f.root.join("secret-link.txt")).unwrap();
    fs::hard_link(outside.join("secret.txt"), f.root.join("secret-hard.txt")).unwrap();
    let result = f
        .service
        .search_workspace_files(&f.project_id, "secret")
        .unwrap();
    assert!(result.paths.is_empty());
    for path in [
        "linked-folder/secret.txt",
        "secret-link.txt",
        "secret-hard.txt",
    ] {
        assert!(f.service.read_workspace_file(&f.project_id, path).is_err());
    }
}
