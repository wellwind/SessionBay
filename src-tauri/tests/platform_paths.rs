//! Native filesystem fixtures only; no real user history or installed Agent.
use serde_json::json;
use sessionbay_lib::{
    catalog::Catalog,
    config::{ConfigStore, Settings},
    models::{AgentKind, HistorySource, SessionQuery},
};
use std::{fs, sync::atomic::AtomicBool};

#[test]
fn unicode_spaced_paths_keep_projects_history_and_settings_independent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("使用者 Work & Data");
    fs::create_dir(&root).unwrap();
    let catalog = Catalog::open(&root.join("app/index.sqlite")).unwrap();
    let project = catalog
        .create_project(root.to_str().unwrap(), "專案 Space & literal")
        .unwrap();
    let cwd = project.path.as_ref().unwrap();
    assert!(std::path::Path::new(cwd).is_dir());
    assert!(catalog
        .create_project(root.to_str().unwrap(), "專案 Space & literal")
        .is_err());
    let history = root.join("唯讀 History");
    fs::create_dir_all(history.join("sessions")).unwrap();
    let transcript = history.join("sessions/synthetic.jsonl");
    let bytes = format!(
        "{}\n{}\n",
        json!({"type":"session_meta","payload":{"id":"native-path-synthetic","cwd":cwd}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"native path fixture"}]}})
    );
    fs::write(&transcript, &bytes).unwrap();
    let source = HistorySource {
        id: "native-path-fixture".into(),
        kind: AgentKind::Codex,
        root: history.to_string_lossy().into_owned(),
        enabled: true,
    };
    let status = catalog
        .sync(&[source], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
    let page = catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].project_id, project.id);
    assert_eq!(fs::read_to_string(&transcript).unwrap(), bytes);
    let settings = ConfigStore::open(root.join("獨立 Settings")).unwrap();
    settings.save_settings(&Settings::default()).unwrap();
    let updated = Settings {
        theme: "light".into(),
        ..Settings::default()
    };
    settings.save_settings(&updated).unwrap();
    let (loaded, warnings) = settings.load_settings();
    assert!(warnings.is_empty());
    assert_eq!(loaded.theme, "light");
    assert_eq!(fs::read_to_string(transcript).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn windows_project_creation_rejects_device_and_stream_names_before_writes() {
    let temp = tempfile::tempdir().unwrap();
    let catalog = Catalog::open(&temp.path().join("app/index.sqlite")).unwrap();
    for name in [
        "CON",
        "nul.txt",
        "COM1",
        "LPT1.log",
        "name:stream",
        "trailing.",
        "trailing ",
    ] {
        assert!(
            catalog
                .create_project(temp.path().to_str().unwrap(), name)
                .is_err(),
            "{name}"
        );
    }
    assert!(catalog.projects().unwrap().is_empty());
}
