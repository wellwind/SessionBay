pub mod adapters;
pub mod agent_activity;
pub mod antigravity;
pub mod antigravity_metadata;
pub mod broker;
pub mod catalog;
pub mod claude_state;
pub mod codex_state;
pub mod config;
pub mod file_input;
pub mod fresh_launch;
pub mod git;
pub mod history_sources;
mod host_environment;
pub mod i18n;
pub mod image_input;
pub mod launch_options;
pub mod launch_provenance;
pub mod models;
pub mod opencode;
pub mod opencode_state;
pub mod os_trash;
pub mod provider_hooks;
pub mod providers;
pub mod removal;
pub mod runtime;
pub mod service;
pub mod shells;
mod terminal_file_links;
pub mod updates;
mod workspace_files;
mod workspace_images;

#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod notifications;
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(windows)]
mod windows_fs;
#[cfg(windows)]
#[allow(dead_code)]
#[path = "broker/windows_security.rs"]
mod windows_security;

pub mod terminal_status;

pub mod terminal_status_launch;
