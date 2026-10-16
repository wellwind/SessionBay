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
        io::{AsHandle, AsRawHandle},
    },
    path::Path,
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
        },
        EqualSid, GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT},
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
