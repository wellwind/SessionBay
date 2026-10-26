//! OS notifications that bring the app back to the pane that raised them.
//!
//! tauri-plugin-notification has no click callback on desktop, so this talks
//! to the same backends directly and waits for activation on a worker thread.
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// Each waiting notification parks a thread until it is clicked or dismissed.
const MAX_WAITING: usize = 8;
static WAITING: AtomicUsize = AtomicUsize::new(0);

pub fn show(
    app: AppHandle,
    title: String,
    body: String,
    target: Option<String>,
) -> Result<(), String> {
    let wait = target.is_some() && WAITING.fetch_add(1, Ordering::SeqCst) < MAX_WAITING;
    if target.is_some() && !wait {
        WAITING.fetch_sub(1, Ordering::SeqCst);
    }
    let identifier = app.config().identifier.clone();
    std::thread::Builder::new()
        .name("notification".into())
        .spawn(move || {
            let clicked = deliver(&identifier, &title, &body, wait);
            if wait {
                WAITING.fetch_sub(1, Ordering::SeqCst);
            }
            if clicked {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("notification-activated", target);
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn deliver(identifier: &str, title: &str, body: &str, wait: bool) -> bool {
    use mac_notification_sys::{Notification, NotificationResponse};
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        // An unbundled dev binary has no identity of its own.
        let _ = mac_notification_sys::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            identifier
        });
    });
    let mut notification = Notification::new();
    notification.title(title).message(body).wait_for_click(wait);
    if !wait {
        notification.asynchronous(true);
    }
    matches!(notification.send(), Ok(NotificationResponse::Click))
}

#[cfg(not(target_os = "macos"))]
fn deliver(identifier: &str, title: &str, body: &str, wait: bool) -> bool {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);
    #[cfg(windows)]
    {
        // Dev builds have no registered AppUserModelID.
        let installed = std::env::current_exe().ok().and_then(|exe| {
            exe.parent().map(|dir| {
                !(dir.ends_with("target/debug")
                    || dir.ends_with("target/release")
                    || dir.ends_with("target\\debug")
                    || dir.ends_with("target\\release"))
            })
        });
        if installed == Some(true) {
            notification.app_id(identifier);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = identifier;
        // Many XDG servers only report body clicks for a declared default action.
        notification.action("default", "開啟");
    }
    let Ok(handle) = notification.show() else {
        return false;
    };
    if !wait {
        return false;
    }
    let mut clicked = false;
    #[cfg(windows)]
    let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
        clicked = matches!(response, notify_rust::NotificationResponse::Default);
    });
    #[cfg(not(windows))]
    handle.wait_for_action(|action| clicked = action == "default");
    clicked
}
