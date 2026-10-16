//! Owner-only Windows directory and named-pipe security. All checks fail closed.
use interprocess::{
    local_socket::tokio::Stream,
    os::windows::security_descriptor::{AsSecurityDescriptor, SecurityDescriptor},
};
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
        },
        EqualSid, GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_ALWAYS,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn token_user() -> io::Result<Vec<usize>> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Handle(token);
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut size);
    }
    if size == 0 || size > 65536 {
        return Err(io::Error::other("Cannot read current Windows user"));
    }
    let mut data = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            data.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(data)
}
fn sid(data: &[usize]) -> PSID {
    unsafe { (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid }
}
pub fn user_sid() -> io::Result<String> {
    let user = token_user()?;
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(sid(&user), &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = Local(value.cast());
    let mut length = 0;
    while length < 256 && unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(io::Error::other("Invalid user SID"));
    }
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(value, length)
    }))
}
pub fn security_descriptor() -> io::Result<SecurityDescriptor> {
    let user = user_sid()?;
    let value = widestring::U16CString::from_str(format!("O:{user}D:P(A;OICI;FA;;;{user})"))
        .map_err(io::Error::other)?;
    SecurityDescriptor::deserialize(&value)
}
/// Create a new lock with the same explicit owner as the private directory.
/// A token's default owner can be a group (not TokenUser), notably for elevated
/// processes. Inheriting the directory DACL does not inherit its owner SID.
/// OPEN_ALWAYS applies this descriptor only to a new file; existing objects are
/// never repaired and must still pass the caller's owner/DACL/reparse checks.
pub fn open_lock(path: &Path) -> io::Result<File> {
    open_lock_with_descriptor(path, &security_descriptor()?)
}
fn open_lock_with_descriptor(path: &Path, descriptor: &SecurityDescriptor) -> io::Result<File> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.as_sd().cast_mut(),
        bInheritHandle: 0,
    };
    let wide = widestring::U16CString::from_os_str(path.as_os_str()).map_err(io::Error::other)?;
    // SAFETY: path/descriptor/attributes remain valid for the synchronous call.
    // OPEN_REPARSE_POINT prevents following the final path component. Sharing
    // matches Rust's normal file handles; exclusivity comes from File::try_lock.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a new owned handle, transferred exactly once.
    Ok(unsafe { File::from_raw_handle(handle) })
}
pub fn private_directory(path: &Path) -> io::Result<()> {
    let descriptor = security_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.as_sd().cast_mut(),
        bInheritHandle: 0,
    };
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime directory must be a real owner-only directory",
        ));
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(
            windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS
                | windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
        )
        .open(path)?;
    verify_handle(file.as_raw_handle(), SE_FILE_OBJECT)
}
fn verify_handle(handle: HANDLE, kind: i32) -> io::Result<()> {
    let mut owner = null_mut();
    let mut acl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    let result = unsafe {
        GetSecurityInfo(
            handle,
            kind,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let _allocation = Local(descriptor);
    let user = token_user()?;
    if owner.is_null() || acl.is_null() || unsafe { EqualSid(owner, sid(&user)) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime object is not owned by the current OS user",
        ));
    }
    let count = unsafe { (*acl).AceCount };
    if count == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime object has no owner access",
        ));
    }
    for index in 0..count {
        let mut ace = null_mut();
        if unsafe { GetAce(acl, index as u32, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
        // Reject every unfamiliar ACE, including inherited grants to other users.
        if unsafe { (*ace).Header.AceType } != 0
            || unsafe { EqualSid((&raw mut (*ace).SidStart).cast(), sid(&user)) } == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Runtime object grants access to another OS identity",
            ));
        }
    }
    Ok(())
}
pub fn verify_file(file: &File) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime lock cannot be a reparse point",
        ));
    }
    verify_handle(file.as_raw_handle(), SE_FILE_OBJECT)
}
pub fn verify_stream(stream: &Stream) -> io::Result<()> {
    let Stream::NamedPipe(pipe) = stream;
    verify_handle(pipe.as_handle().as_raw_handle(), SE_KERNEL_OBJECT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_lock_has_explicit_user_owner_and_a_noninheritable_handle() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        private_directory(&directory).unwrap();
        let file = open_lock(&directory.join("broker.lock")).unwrap();
        // This fails with default file ownership on an elevated account whose
        // TokenOwner is Administrators rather than TokenUser.
        verify_file(&file).unwrap();
        let mut flags = 0;
        assert_ne!(
            unsafe { GetHandleInformation(file.as_raw_handle(), &mut flags) },
            0
        );
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        drop(file);
        verify_file(&open_lock(&directory.join("broker.lock")).unwrap()).unwrap();
    }

    fn descriptor_text(file: &File) -> String {
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
        };
        let mut descriptor = null_mut();
        let information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    information,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let _descriptor = Local(descriptor);
        let mut value = null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    information,
                    &mut value,
                    null_mut(),
                )
            },
            0
        );
        let _value = Local(value.cast());
        // SAFETY: successful conversion returns a NUL-terminated UTF-16 string.
        unsafe { widestring::U16CStr::from_ptr_str(value).to_string_lossy() }
    }

    #[test]
    fn opening_existing_default_owner_lock_does_not_replace_its_security_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        private_directory(&directory).unwrap();
        let path = directory.join("broker.lock");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let before = descriptor_text(&file);
        let accepted_before = verify_file(&file).is_ok();
        drop(file);
        let reopened = open_lock(&path).unwrap();
        assert_eq!(descriptor_text(&reopened), before);
        assert_eq!(verify_file(&reopened).is_ok(), accepted_before);
        // On an elevated runner the default owner can differ from TokenUser;
        // in that case the existing lock must remain rejected, never repaired.
        if !accepted_before {
            assert_eq!(
                verify_file(&reopened).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }

    #[test]
    fn opening_existing_shared_lock_never_repairs_its_owner_or_acl() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        private_directory(&directory).unwrap();
        let path = directory.join("broker.lock");
        let user = user_sid().unwrap();
        // Synthetic fixture only: extra Everyone read access must be rejected.
        let value =
            widestring::U16CString::from_str(format!("O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)"))
                .unwrap();
        let descriptor = SecurityDescriptor::deserialize(&value).unwrap();
        let file = open_lock_with_descriptor(&path, &descriptor).unwrap();
        use std::io::Write;
        (&file).write_all(b"must-remain-unchanged").unwrap();
        let before = descriptor_text(&file);
        assert_eq!(
            verify_file(&file).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        drop(file);
        let reopened = open_lock(&path).unwrap();
        assert_eq!(descriptor_text(&reopened), before);
        assert_eq!(
            verify_file(&reopened).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"must-remain-unchanged");
    }
}
