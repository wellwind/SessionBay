//! Local-only, framed IPC. Filesystem permissions / named-pipe ACLs are the
//! authentication boundary; no TCP port, reusable token, or PID adoption exists.
use interprocess::local_socket::{
    tokio::{prelude::*, Listener, Stream},
    ListenerOptions, Name,
};
#[cfg(unix)]
use interprocess::{
    local_socket::traits::StreamCommon, os::unix::local_socket::ListenerOptionsExt,
};
use std::{
    fs::{self, File, OpenOptions},
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
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(directory.join("broker.lock"))?;
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
    file.try_lock()
        .map_err(|error| io::Error::new(io::ErrorKind::WouldBlock, error.to_string()))?;
    Ok(file)
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
    #[cfg(unix)]
    let options = options.mode(0o600);
    #[cfg(windows)]
    let options = {
        use interprocess::os::windows::local_socket::ListenerOptionsExt;
        options.security_descriptor(windows::security_descriptor()?)
    };
    options.create_tokio()
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
