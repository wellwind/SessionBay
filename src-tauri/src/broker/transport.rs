//! Local-only, framed IPC. Filesystem permissions / named-pipe ACLs are the
//! authentication boundary; no TCP port, reusable token, or PID adoption exists.
#[cfg(unix)]
use interprocess::local_socket::traits::StreamCommon;
use interprocess::local_socket::{
    tokio::{prelude::*, Listener, Stream},
    ListenerOptions, Name,
};
#[cfg(all(unix, not(target_os = "macos")))]
use interprocess::os::unix::local_socket::ListenerOptionsExt;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(windows)]
#[path = "windows_security.rs"]
mod windows;

pub fn private_directory(parent: &Path) -> io::Result<PathBuf> {
    let directory = parent.join("runtime-broker-v1");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(&directory)?;
        // Never repair an unexpectedly exposed directory silently.
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Runtime directory must be an owner-only real directory",
            ));
        }
    }
    #[cfg(windows)]
    windows::private_directory(&directory)?;
    fs::canonicalize(directory)
}

pub fn lock(directory: &Path) -> io::Result<File> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join("broker.lock"))?
    };
    #[cfg(windows)]
    let file = windows::open_lock(&directory.join("broker.lock"))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Runtime lock is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = file.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Runtime lock is not owner-only",
            ));
        }
    }
    #[cfg(windows)]
    windows::verify_file(&file)?;
    // Preserve permission/unsupported/I/O errors. Only TryLockError::WouldBlock
    // proves another handle currently owns the broker lock.
    file.try_lock().map_err(io::Error::from)?;
    Ok(file)
}

pub fn ownership_available(directory: &Path) -> io::Result<bool> {
    match lock(directory) {
        Ok(_ownership) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn socket_path(directory: &Path) -> io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    // Darwin sockaddr_un is only 104 bytes. Application Support paths and long
    // account names must not make otherwise valid workspaces impossible to open.
    let uid = unsafe { libc::geteuid() };
    let digest = Sha256::digest(directory.as_os_str().as_encoded_bytes());
    let hash = format!("{digest:x}");
    let parent = PathBuf::from(format!("/tmp/sessionbay-{uid}-{}", &hash[..24]));
    match fs::DirBuilder::new().mode(0o700).create(&parent) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(&parent)?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime socket directory is not owner-only",
        ));
    }
    Ok(parent.join("control.sock"))
}

fn name(directory: &Path) -> io::Result<Name<'static>> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        socket_path(directory)?
            .to_fs_name::<GenericFilePath>()
            .map(Name::into_owned)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        use sha2::{Digest, Sha256};
        let identity = windows::user_sid()?;
        let digest = Sha256::digest(format!("{}\0{}", identity, directory.display()).as_bytes());
        format!("sessionbay-runtime-v1-{digest:x}")
            .to_ns_name::<GenericNamespaced>()
            .map(Name::into_owned)
    }
}

/// Caller must hold the exclusive OS lock for this directory throughout use.
pub fn listener(directory: &Path) -> io::Result<Listener> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let path = socket_path(directory)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path)?,
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Unexpected runtime endpoint; refusing to replace it",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    let options = ListenerOptions::new()
        .name(name(directory)?)
        .reclaim_name(false);
    #[cfg(all(unix, not(target_os = "macos")))]
    let options = options.mode(0o600);
    #[cfg(windows)]
    let options = {
        use interprocess::os::windows::local_socket::ListenerOptionsExt;
        options.security_descriptor(windows::security_descriptor()?)
    };
    let listener = options.create_tokio()?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        // Darwin rejects fchmod on an unbound socket. The verified 0700 parent
        // prevents other users from connecting while we set the bound path mode.
        fs::set_permissions(socket_path(directory)?, fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

pub fn authenticate(stream: &Stream) -> io::Result<()> {
    #[cfg(unix)]
    if stream.peer_creds()?.euid() != Some(unsafe { libc::geteuid() }) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime peer belongs to another OS user",
        ));
    }
    #[cfg(windows)]
    windows::verify_stream(stream)?;
    Ok(())
}

pub async fn read_frame(stream: &mut Stream, limit: usize) -> io::Result<Vec<u8>> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Runtime IPC frame exceeds limit",
        ));
    }
    let mut data = vec![0; length];
    stream.read_exact(&mut data).await?;
    Ok(data)
}

pub async fn write_frame(stream: &mut Stream, bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Runtime IPC frame exceeds limit",
        ));
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

pub async fn request(directory: &Path, bytes: &[u8]) -> io::Result<Vec<u8>> {
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let mut stream = Stream::connect(name(directory)?).await?;
        // Authenticate before transmitting launch arguments or terminal input.
        authenticate(&stream)?;
        write_frame(&mut stream, bytes).await?;
        read_frame(&mut stream, MAX_FRAME).await
    }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Runtime broker did not respond; the action may have completed. Reconnect before retrying."))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_listener_connects_and_authenticates_with_owner_only_permissions() {
        let parent = tempfile::tempdir().unwrap();
        let directory = private_directory(parent.path()).unwrap();
        let _ownership = lock(&directory).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let socket = socket_path(&directory).unwrap();
        runtime.block_on(async {
            let listener = listener(&directory).unwrap();
            assert_eq!(
                fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(socket.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            let server = tokio::spawn(async move {
                let mut stream = listener.accept().await.unwrap();
                authenticate(&stream).unwrap();
                let data = read_frame(&mut stream, MAX_FRAME).await.unwrap();
                write_frame(&mut stream, &data).await.unwrap();
            });
            assert_eq!(
                request(&directory, b"broker-ready").await.unwrap(),
                b"broker-ready"
            );
            server.await.unwrap();
        });
        fs::remove_file(&socket).unwrap();
        fs::remove_dir(socket.parent().unwrap()).unwrap();
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    #[test]
    fn lock_io_errors_keep_their_original_kind() {
        let error = io::Error::from(std::fs::TryLockError::Error(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "synthetic access denial",
        )));
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            io::Error::from(std::fs::TryLockError::WouldBlock).kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn concurrent_lock_creation_has_exactly_one_owner_and_releases_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let directory = private_directory(root.path()).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let readers: Vec<_> = (0..2)
            .map(|_| {
                let directory = directory.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    lock(&directory)
                })
            })
            .collect();
        let results: Vec<_> = readers
            .into_iter()
            .map(|reader| reader.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .next()
                .unwrap()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(!ownership_available(&directory).unwrap());
        drop(results);
        assert!(ownership_available(&directory).unwrap());
    }

    #[test]
    fn invalid_lock_is_reported_before_attempting_to_spawn_or_retry() {
        let root = tempfile::tempdir().unwrap();
        let directory = private_directory(root.path()).unwrap();
        std::fs::create_dir(directory.join("broker.lock")).unwrap();
        assert_ne!(
            ownership_available(&directory).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let started = std::time::Instant::now();
        let error = match crate::broker::BrokerClient::connect(
            root.path(),
            &root.path().join("missing-executable"),
        ) {
            Ok(_) => panic!("invalid ownership lock accepted"),
            Err(error) => error,
        };
        assert!(
            error.starts_with("Cannot verify runtime broker ownership lock:"),
            "{error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "lock errors must not take the 12-second retry path"
        );
        assert!(directory.join("broker.lock").is_dir());
    }
}
