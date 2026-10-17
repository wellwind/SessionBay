pub mod adapters;
pub mod antigravity;
pub mod antigravity_metadata;
pub mod broker;
pub mod catalog;
pub mod config;
pub mod file_input;
pub mod fresh_launch;
pub mod history_sources;
pub mod image_input;
pub mod launch_options;
pub mod launch_provenance;
pub mod models;
pub mod opencode;
pub mod providers;
pub mod runtime;
pub mod service;
pub mod shells;

#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(windows)]
mod windows_fs;
