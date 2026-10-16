pub mod adapters;
pub mod antigravity;
pub mod antigravity_metadata;
pub mod catalog;
pub mod config;
pub mod history_sources;
pub mod launch_options;
pub mod models;
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
