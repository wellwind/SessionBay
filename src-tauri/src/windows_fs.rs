//! Read-only Windows file handles with identity and final-component reparse checks.
//! No SQLite connection or write-capable handle ever targets a history source.
use std::{
    fs::{File, OpenOptions},
    io,
    mem::{size_of, MaybeUninit},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, Prefix},
};
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, GetFileInformationByHandleEx, GetFileType, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_TYPE_DISK, SECURITY_IDENTIFICATION,
};

pub(crate) fn valid_filesystem_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
        Prefix::UNC(_, share) | Prefix::VerbatimUNC(_, share) => {
            let Some(share) = share.to_str() else {
                return false;
            };
            if share.eq_ignore_ascii_case("pipe") || share.eq_ignore_ascii_case("mailslot") {
                return false;
            }
        }
        _ => return false,
    }
    path.components().all(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(valid_component),
        Component::ParentDir => false,
        _ => true,
    })
}

fn valid_component(name: &str) -> bool {
    // Win32 can interpret CON.txt, COM1, etc. as devices even under C:\data.
    // Reject ADS and names whose trailing normalization changes their meaning.
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name.contains([':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].contains(&stem.as_str()) {
        return false;
    }
    for prefix in ["COM", "LPT"] {
        if stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        }) {
            return false;
        }
    }
    true
}

pub(crate) fn open_regular_readonly_nofollow(path: &Path) -> io::Result<File> {
    // Reject device namespaces/names before opening: a device can block before
    // the eventual handle metadata check, unlike an ordinary filesystem file.
    if !valid_filesystem_path(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "History source must be an absolute filesystem path without device names or streams",
        ));
    }
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        // Defense in depth if an ancestor is replaced with a device route.
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(path)?;
    let metadata = file.metadata()?;
    // SAFETY: File owns a live handle for the entire type query.
    let kind = unsafe { GetFileType(file.as_raw_handle()) };
    if kind != FILE_TYPE_DISK
        || !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "History source must be a regular non-reparse file",
        ));
    }
    Ok(file)
}

/// FileIdInfo retains the 128-bit identity used by ReFS as well as NTFS.
/// Filesystems that cannot return a reliable identity fail closed.
pub(crate) fn identity_from_file(file: &File) -> io::Result<String> {
    let mut info = MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: the File keeps the handle alive, and the API is passed a correctly
    // sized, aligned writable FILE_ID_INFO buffer, read only after success.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful FileIdInfo call initialized the complete structure.
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "{:016x}:{:032x}",
        info.VolumeSerialNumber,
        u128::from_le_bytes(info.FileId.Identifier)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn identity_distinguishes_replacement_and_keeps_sources_readonly() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source with spaces.txt");
        fs::write(&path, "synthetic source").unwrap();
        let first = open_regular_readonly_nofollow(&path).unwrap();
        let original = identity_from_file(&first).unwrap();
        assert_eq!(
            original,
            identity_from_file(&open_regular_readonly_nofollow(&path).unwrap()).unwrap()
        );
        let replacement = temp.path().join("replacement.txt");
        fs::write(&replacement, "synthetic source").unwrap();
        fs::rename(&path, temp.path().join("old.txt")).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_ne!(
            original,
            identity_from_file(&open_regular_readonly_nofollow(&path).unwrap()).unwrap()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "synthetic source");
        assert!(open_regular_readonly_nofollow(temp.path()).is_err());
        assert!(open_regular_readonly_nofollow(Path::new(r"\\.\NUL")).is_err());
    }

    #[test]
    fn rejects_device_names_streams_and_ambiguous_paths_before_open() {
        for invalid in [
            r"C:\data\CON",
            r"C:\data\con.txt",
            r"C:\data\NUL.exe",
            r"C:\data\PRN ",
            r"C:\data\AUX.",
            r"C:\data\COM1",
            r"C:\data\LPT9.log",
            r"C:\data\COM¹",
            r"C:\data\file:stream",
            r"C:\data\.. \file",
            r"\\server\pipe\name",
            r"\\.\pipe\name",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\file",
        ] {
            assert!(
                !valid_filesystem_path(Path::new(invalid)),
                "accepted {invalid}"
            );
            assert_eq!(
                open_regular_readonly_nofollow(Path::new(invalid))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert!(valid_filesystem_path(Path::new(
            r"C:\data\ordinary file.txt"
        )));
        assert!(valid_filesystem_path(Path::new(
            r"\\?\C:\data\ordinary file.txt"
        )));
        assert!(valid_filesystem_path(Path::new(
            r"\\server\share\ordinary file.txt"
        )));
    }

    #[test]
    fn rejects_symlink_when_host_allows_creation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.txt");
        fs::write(&source, "synthetic source").unwrap();
        let link = temp.path().join("link.txt");
        match std::os::windows::fs::symlink_file(&source, &link) {
            Ok(()) => assert!(open_regular_readonly_nofollow(&link).is_err()),
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    || error.raw_os_error()
                        == Some(
                            windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32,
                        ) =>
            {
                eprintln!("SKIPPED symlink fixture: Windows requires Developer Mode or symlink privilege ({error})");
            }
            Err(error) => panic!("Cannot create synthetic symlink: {error}"),
        }
    }
}
