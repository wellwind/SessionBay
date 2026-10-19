//! Runtime-only writer fence; legacy arrays never establish pristine history.
use super::*;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Kind {
    Legacy,
    Modern,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    work_attempted: bool,
    records: Vec<RuntimeRecord>,
}
pub(super) fn decode(bytes: &[u8]) -> Result<(Kind, bool, Vec<RuntimeRecord>), String> {
    if bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b'[')
    {
        let records = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        return Ok((Kind::Legacy, true, records));
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if envelope.schema_version != 2 {
        return Err("Unsupported runtime metadata schema; original file preserved".into());
    }
    // Inconsistent historical records can never certify pristine ownership.
    let attempted = envelope.work_attempted || !envelope.records.is_empty();
    Ok((Kind::Modern, attempted, envelope.records))
}
pub(super) fn encode(
    kind: Kind,
    attempted: bool,
    records: Vec<RuntimeRecord>,
) -> Result<Vec<u8>, String> {
    match kind {
        Kind::Legacy => serde_json::to_vec(&records),
        Kind::Modern => serde_json::to_vec(&Envelope {
            schema_version: 2,
            work_attempted: attempted,
            records,
        }),
    }
    .map_err(|e| e.to_string())
}
pub(super) fn sync_directory(directory: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}
/// Only the successful creator of a new private directory may bootstrap it.
/// Holding the normal broker lock fences a racing legacy owner. Existing data
/// always wins; no empty/missing legacy metadata is upgraded by inference.
#[cfg(unix)]
pub(super) fn initialize_fresh(directory: &std::path::Path) -> std::io::Result<()> {
    let _owner = match transport::lock(directory) {
        Ok(owner) => owner,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(error) => return Err(error),
    };
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("sessions.json"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    let bytes = encode(Kind::Modern, false, Vec::new()).map_err(std::io::Error::other)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    sync_directory(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_arrays_are_readable_but_never_pristine_and_keep_their_format() {
        let (kind, attempted, records) = decode(b"[]").unwrap();
        assert!(kind == Kind::Legacy);
        assert!(attempted);
        assert_eq!(encode(kind, attempted, records).unwrap(), b"[]");
    }
    #[test]
    fn modern_envelope_fences_legacy_decoder_and_rejects_unknown_schema() {
        let bytes = encode(Kind::Modern, false, vec![]).unwrap();
        assert!(serde_json::from_slice::<Vec<RuntimeRecord>>(&bytes).is_err());
        assert!(!decode(&bytes).unwrap().1);
        for input in [
            br#"{"schemaVersion":3,"workAttempted":false,"records":[]}"#.as_slice(),
            br#"{"schemaVersion":2,"records":[]}"#,
            br#"{"schemaVersion":2,"workAttempted":false,"records":[],"future":true}"#,
        ] {
            assert!(decode(input).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn only_new_directory_creator_can_initialize_and_legacy_owner_wins() {
        let root = tempfile::tempdir().unwrap();
        let directory = transport::private_directory(root.path()).unwrap();
        assert!(
            !decode(&fs::read(directory.join("sessions.json")).unwrap())
                .unwrap()
                .1
        );
        fs::write(directory.join("sessions.json"), b"[]").unwrap();
        initialize_fresh(&directory).unwrap();
        assert_eq!(fs::read(directory.join("sessions.json")).unwrap(), b"[]");
        fs::remove_file(directory.join("sessions.json")).unwrap();
        transport::private_directory(root.path()).unwrap();
        assert!(!directory.join("sessions.json").exists());
        let owner = transport::lock(&directory).unwrap();
        initialize_fresh(&directory).unwrap();
        assert!(!directory.join("sessions.json").exists());
        drop(owner);
    }
    #[test]
    fn malformed_unknown_metadata_is_preserved_on_open_failure() {
        for bytes in [
            b"broken".as_slice(),
            br#"{"schemaVersion":99,"workAttempted":false,"records":[]}"#,
        ] {
            let root = tempfile::tempdir().unwrap();
            fs::write(root.path().join("sessions.json"), bytes).unwrap();
            assert!(Host::open(root.path().into()).is_err());
            assert_eq!(fs::read(root.path().join("sessions.json")).unwrap(), bytes);
        }
    }
}
