pub mod adapters;
pub mod catalog;
pub mod config;
pub mod launch_options;
pub mod models;
pub mod runtime;
pub mod service;

#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::run;
