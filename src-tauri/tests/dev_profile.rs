use rusqlite::{params, Connection};
use sessionbay_lib::{
    catalog::Catalog,
    config::{ConfigStore, Settings},
    dev_profile::{initialize, is_development, ProfileImport, DEVELOPMENT_ID, PRODUCTION_ID},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

fn snapshot(directory: &Path) -> BTreeMap<String, [u8; 32]> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                Sha256::digest(fs::read(entry.path()).unwrap()).into(),
            )
        })
        .collect()
}

fn production(directory: &Path) -> (Catalog, Connection) {
    let store = ConfigStore::open(directory.to_owned()).unwrap();
    let mut settings = Settings {
        theme: "light".into(),
        font_size: 18,
        onboarding_complete: true,
        ..Settings::default()
    };
    settings.profiles[0].name = "Synthetic production shell".into();
    settings.profiles[0]
        .env
        .insert("SYNTHETIC_SETTING".into(), "value".into());
    settings.executables.codex = "synthetic-codex".into();
    for source in &mut settings.sources {
        source.root = directory
            .join(format!("synthetic-{}", source.id))
            .to_string_lossy()
            .into_owned();
    }
    store.save_settings(&settings).unwrap();
    let catalog = Catalog::open(&directory.join("catalog.sqlite")).unwrap();
    // Hold a WAL connection open so the importer must see committed WAL rows.
    let conn = Connection::open(directory.join("catalog.sqlite")).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    conn.execute("INSERT INTO projects(id,name,path,launch_path,pinned,manual) VALUES('curated','Chosen project',?1,?2,1,1)",
        params![directory.join("missing-project").to_str().unwrap(), directory.join("missing-launch").to_str().unwrap()]).unwrap();
    conn.execute_batch("INSERT INTO projects(id,name,manual) VALUES('automatic','Only discovered',0);
        INSERT INTO sources(id,kind,root,storage_root,enabled) VALUES('source','codex','synthetic','synthetic',1);
        INSERT INTO sessions(id,source_id,kind,external_id,project_id,title,updated_at,time_source,archived,partial)
        VALUES('session','source','codex','session','curated','Synthetic conversation','2026-01-01','test',0,0);
        INSERT INTO session_trash(id,session_id,snapshot,source_root,deleted_at)
        VALUES('trash','session','{}','synthetic','2026-01-01');").unwrap();
    fs::write(
        directory.join("workspace.json"),
        b"synthetic production layout",
    )
    .unwrap();
    fs::write(directory.join("git-hosts.json"), b"synthetic host metadata").unwrap();
    fs::write(
        directory.join("tokens.json"),
        b"synthetic tokens, never real credentials",
    )
    .unwrap();
    (catalog, conn)
}

struct ProductionWriter {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}

impl ProductionWriter {
    fn start(directory: &Path) -> Self {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "production_writer_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("SESSIONBAY_TEST_PROFILE_SOURCE", directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut writer = Self {
            child,
            input,
            output,
        };
        writer.wait_for("PROFILE_READY");
        writer
    }

    fn wait_for(&mut self, marker: &str) {
        use std::io::BufRead;
        loop {
            let mut line = String::new();
            assert!(
                self.output.read_line(&mut line).unwrap() > 0,
                "Synthetic production writer exited"
            );
            if line.contains(marker) {
                return;
            }
        }
    }

    fn rename(&mut self) {
        use std::io::Write;
        writeln!(self.input, "rename").unwrap();
        self.input.flush().unwrap();
        self.wait_for("PROFILE_UPDATED");
    }
}

impl Drop for ProductionWriter {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = writeln!(self.input, "quit");
        let _ = self.input.flush();
        let _ = self.child.wait();
    }
}

// Production runs in a different process. SQLite shares writable SHM mappings
// inside one process, so keep that real process boundary in this fixture.
#[test]
#[ignore = "subprocess fixture, launched only with a synthetic temporary directory"]
fn production_writer_fixture() {
    use std::io::{BufRead, Write};
    let directory =
        std::env::var_os("SESSIONBAY_TEST_PROFILE_SOURCE").expect("synthetic fixture directory");
    let (_catalog, connection) = production(Path::new(&directory));
    println!("PROFILE_READY");
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        match line.unwrap().as_str() {
            "rename" => {
                connection
                    .execute(
                        "UPDATE projects SET name='Updated production name' WHERE id='curated'",
                        [],
                    )
                    .unwrap();
                println!("PROFILE_UPDATED");
                std::io::stdout().flush().unwrap();
            }
            "quit" => break,
            _ => panic!("Unknown synthetic fixture command"),
        }
    }
}

#[test]
fn imports_once_without_source_writes_or_index_layout_trash_and_tokens() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join(PRODUCTION_ID);
    let dev = temp.path().join(DEVELOPMENT_ID);
    let _writer = ProductionWriter::start(&prod);
    let before = snapshot(&prod);
    assert!(initialize(&dev, &prod).unwrap());
    assert_eq!(snapshot(&prod), before);
    let (settings, warnings) = ConfigStore::open(dev.clone()).unwrap().load_settings();
    assert!(warnings.is_empty());
    assert_eq!(settings.theme, "light");
    assert_eq!(settings.font_size, 18);
    assert_eq!(settings.profiles[0].name, "Synthetic production shell");
    assert!(!settings.update_checks);
    let mut expected: serde_json::Value =
        serde_json::from_slice(&fs::read(prod.join("settings.json")).unwrap()).unwrap();
    expected["updateChecks"] = false.into();
    assert_eq!(serde_json::to_value(&settings).unwrap(), expected);
    let catalog = Catalog::open(&dev.join("catalog.sqlite")).unwrap();
    let projects = catalog.projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, "curated");
    assert_eq!(projects[0].name, "Chosen project");
    assert!(projects[0].curated && projects[0].pinned);
    assert!(projects[0]
        .launch_path
        .as_ref()
        .unwrap()
        .ends_with("missing-launch"));
    let conn = Connection::open(dev.join("catalog.sqlite")).unwrap();
    for table in ["sources", "sessions", "files", "messages", "session_trash"] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} must not be imported");
    }
    for name in ["workspace.json", "git-hosts.json", "tokens.json"] {
        assert!(!dev.join(name).exists());
    }
    let store = ConfigStore::open(dev.clone()).unwrap();
    let mut changed = settings;
    changed.font_size = 20;
    store.save_settings(&changed).unwrap();
    assert!(!initialize(&dev, &prod).unwrap());
    assert_eq!(store.load_settings().0.font_size, 20);
    assert_eq!(snapshot(&prod), before);
}

#[test]
fn repeated_import_merges_projects_and_preserves_dev_private_data() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production");
    let dev = temp.path().join("development");
    let mut writer = ProductionWriter::start(&prod);
    initialize(&dev, &prod).unwrap();
    let store = ConfigStore::open(dev.clone()).unwrap();
    let catalog = Catalog::open(&dev.join("catalog.sqlite")).unwrap();
    let conn = Connection::open(dev.join("catalog.sqlite")).unwrap();
    conn.execute_batch("INSERT INTO projects(id,name,path,manual) VALUES('dev-only','Dev only','/synthetic/dev',1);").unwrap();
    for name in ["workspace.json", "git-hosts.json", "tokens.json"] {
        fs::write(dev.join(name), b"synthetic dev data").unwrap();
    }
    writer.rename();
    let before = snapshot(&prod);
    ProfileImport::read(&prod)
        .unwrap()
        .apply(&store, &catalog)
        .unwrap();
    ProfileImport::read(&prod)
        .unwrap()
        .apply(&store, &catalog)
        .unwrap();
    let projects = catalog.projects().unwrap();
    assert_eq!(projects.len(), 2);
    assert!(projects.iter().any(|p| p.id == "dev-only"));
    assert!(projects
        .iter()
        .any(|p| p.id == "curated" && p.name == "Updated production name"));
    for name in ["workspace.json", "git-hosts.json", "tokens.json"] {
        assert_eq!(fs::read(dev.join(name)).unwrap(), b"synthetic dev data");
    }
    assert_eq!(snapshot(&prod), before);
}

#[test]
fn missing_production_initializes_once_and_invalid_sources_do_not_overwrite_dev() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production");
    let dev = temp.path().join("development");
    assert!(!initialize(&dev, &prod).unwrap());
    assert!(!prod.exists());
    let before = fs::read(dev.join("settings.json")).unwrap();
    fs::create_dir(&prod).unwrap();
    fs::write(prod.join("settings.json"), b"invalid synthetic settings").unwrap();
    assert!(ProfileImport::read(&prod).is_err());
    assert!(!initialize(&dev, &prod).unwrap());
    assert_eq!(fs::read(dev.join("settings.json")).unwrap(), before);
    let store = ConfigStore::open(prod.clone()).unwrap();
    store.save_settings(&Settings::default()).unwrap();
    fs::write(prod.join("catalog.sqlite"), b"invalid synthetic database").unwrap();
    assert!(ProfileImport::read(&prod).is_err());
    assert_eq!(fs::read(dev.join("settings.json")).unwrap(), before);
    assert!(initialize(&prod, &prod).is_err());
}

#[test]
fn production_is_never_treated_as_development() {
    assert!(!is_development(PRODUCTION_ID));
    assert!(!is_development("unrelated.identifier"));
    assert_eq!(is_development(DEVELOPMENT_ID), cfg!(debug_assertions));
}

#[test]
fn imports_curated_projects_even_when_production_uses_unsaved_default_settings() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production");
    let dev = temp.path().join("development");
    let _writer = ProductionWriter::start(&prod);
    fs::remove_file(prod.join("settings.json")).unwrap();
    let before = snapshot(&prod);
    assert!(initialize(&dev, &prod).unwrap());
    let catalog = Catalog::open(&dev.join("catalog.sqlite")).unwrap();
    assert_eq!(catalog.projects().unwrap().len(), 1);
    assert_eq!(snapshot(&prod), before);
}

#[test]
fn reads_a_checkpointed_production_catalog_without_creating_sidecars() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production # ? 中文");
    let dev = temp.path().join("development");
    let writer = ProductionWriter::start(&prod);
    drop(writer);
    assert!(!prod.join("catalog.sqlite-wal").exists());
    let before = snapshot(&prod);
    assert!(initialize(&dev, &prod).unwrap());
    assert_eq!(snapshot(&prod), before);
}

#[test]
fn unreadable_wal_sidecars_are_not_created_or_repaired_in_production() {
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production");
    let mut writer = ProductionWriter::start(&prod);
    writer.child.kill().unwrap();
    writer.child.wait().unwrap();
    drop(writer);
    assert!(prod.join("catalog.sqlite-wal").exists());
    fs::remove_file(prod.join("catalog.sqlite-shm")).unwrap();
    let before = snapshot(&prod);
    assert!(ProfileImport::read(&prod).is_err());
    assert_eq!(snapshot(&prod), before);
}

#[cfg(unix)]
#[test]
fn imports_from_a_read_only_production_folder_without_changing_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let prod = temp.path().join("production");
    let dev = temp.path().join("development");
    let writer = ProductionWriter::start(&prod);
    fs::set_permissions(&prod, fs::Permissions::from_mode(0o500)).unwrap();
    let before = snapshot(&prod);
    assert!(initialize(&dev, &prod).unwrap());
    assert_eq!(snapshot(&prod), before);
    assert_eq!(
        fs::metadata(&prod).unwrap().permissions().mode() & 0o777,
        0o500
    );
    fs::set_permissions(&prod, fs::Permissions::from_mode(0o700)).unwrap();
    drop(writer);
}
