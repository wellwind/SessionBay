#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if sessionbay_lib::provider_hooks::run_callback_if_requested() {
        return;
    }
    if let Some(directory) = sessionbay_lib::broker::stop_arguments() {
        if let Err(error) = sessionbay_lib::broker::BrokerClient::stop_existing(&directory) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(directory) = sessionbay_lib::broker::broker_arguments() {
        if let Err(error) = sessionbay_lib::broker::run(directory) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    sessionbay_lib::run();
}
