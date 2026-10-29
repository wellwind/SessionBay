//! Import only preferences and curated project metadata into the development profile.
use crate::{
    catalog::{Catalog, CuratedProject},
    config::{ConfigStore, Settings},
    tr,
};
use rusqlite::{Connection, OpenFlags};
use std::{fs, path::Path, time::SystemTime};

pub const PRODUCTION_ID: &str = "dev.fullstackladder.sessionbay";
pub const DEVELOPMENT_ID: &str = "dev.fullstackladder.sessionbay.dev";

pub fn is_development(identifier: &str) -> bool {
    cfg!(debug_assertions) && identifier == DEVELOPMENT_ID
}

pub struct ProfileImport {
    pub settings: Settings,
    pub projects: Vec<CuratedProject>,
}

fn stamp(path: &Path) -> Result<Option<(u64, SystemTime)>, String> {
    match fs::metadata(path) {
        Ok(meta) => Ok(Some((
            meta.len(),
            meta.modified().map_err(|e| e.to_string())?,
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

impl ProfileImport {
    pub fn read(production: &Path) -> Result<Self, String> {
        // Do not open a ConfigStore: opening it creates/chmods the source directory.
        let store = ConfigStore {
            directory: production.to_owned(),
        };
        if !production.join("settings.json").is_file()
            && !production.join("catalog.sqlite").is_file()
        {
            return Err(tr!("Session Bay has no saved settings to import."));
        }
        let (mut settings, warnings) = store.load_settings();
        if !warnings.is_empty() {
            return Err(warnings.join("\n"));
        }
        settings.update_checks = false;
        let projects = read_projects(production).map_err(|error| tr!(
            "Could not read the Session Bay catalog. Open Session Bay once, then try importing again: {{error}}",
            error = error
        ))?;
        Ok(Self { settings, projects })
    }

    pub fn apply(&self, destination: &ConfigStore, catalog: &Catalog) -> Result<(), String> {
        catalog.import_curated_projects(&self.projects)?;
        destination.save_settings(&self.settings)
    }
}

fn read_projects(production: &Path) -> Result<Vec<CuratedProject>, String> {
    let database = production.join("catalog.sqlite");
    let wal = production.join("catalog.sqlite-wal");
    if stamp(&database)?.is_none() {
        return Ok(Vec::new());
    }
    for _ in 0..3 {
        let before = (stamp(&database)?, stamp(&wal)?);
        // Production belongs to a separate process; never open it writable here.
        // A read-only SQLite connection can otherwise open WAL shared memory
        // read/write. Force read-only sidecars; do not copy the search index.
        // A checkpointed database needs no sidecars. Verify its file stamps
        // after reading because immutable readers do not acquire SQLite locks.
        let has_wal = before.1.is_some_and(|(length, _)| length > 0);
        let options = if has_wal {
            "mode=ro&readonly_shm=1"
        } else {
            "mode=ro&immutable=1"
        };
        let uri = database_uri(&database, options)?;
        let conn = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        let mut query = conn
            .prepare(
                "SELECT id,name,path,launch_path,pinned FROM projects WHERE manual=1 ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let projects = query
            .query_map([], |row| {
                Ok(CuratedProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    launch_path: row.get(3)?,
                    pinned: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if before == (stamp(&database)?, stamp(&wal)?) {
            return Ok(projects);
        }
    }
    Err(tr!(
        "The Session Bay catalog is changing. Try importing again when indexing has finished."
    ))
}

fn database_uri(path: &Path, options: &str) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or_else(|| tr!("The app data path must be valid UTF-8."))?;
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    let mut uri = String::from("file:");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/:-._~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(uri, "%{byte:02X}").map_err(|e| e.to_string())?;
        }
    }
    Ok(format!("{uri}?{options}"))
}

pub fn initialize(destination: &Path, production: &Path) -> Result<bool, String> {
    if destination == production
        || fs::canonicalize(destination)
            .ok()
            .zip(fs::canonicalize(production).ok())
            .is_some_and(|(destination, production)| destination == production)
    {
        return Err(tr!(
            "The development and production data folders must be separate."
        ));
    }
    if destination.join("settings.json").exists() {
        return Ok(false);
    }
    if !production.join("settings.json").exists() && !production.join("catalog.sqlite").exists() {
        ConfigStore::open(destination.to_owned())?.save_settings(&Settings {
            update_checks: false,
            ..Settings::default()
        })?;
        return Ok(false);
    }
    let import = ProfileImport::read(production)?;
    let store = ConfigStore::open(destination.to_owned())?;
    let catalog = Catalog::open(&destination.join("catalog.sqlite"))?;
    import.apply(&store, &catalog)?;
    Ok(true)
}
