//! Headless harness for native lifecycle integration tests. Production launches
//! the installed desktop executable in its pre-WebView broker mode.
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
    let Some(directory) = sessionbay_lib::broker::broker_arguments() else {
        eprintln!("Expected --sessionbay-runtime-broker <application-data-directory>");
        std::process::exit(2);
    };
    if let Err(error) = sessionbay_lib::broker::run(directory) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
