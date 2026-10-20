//! Times one catalog sync of an OpenCode source: `opencode_benchmark <root> <catalog.db>`.
//! Run under `/usr/bin/time -v` for peak RSS. Generate data with a script; no
//! large fixture is committed.
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource},
};
use std::sync::atomic::AtomicBool;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("root");
    let catalog = args.next().expect("catalog path");
    let catalog = Catalog::open(std::path::Path::new(&catalog)).unwrap();
    let source = HistorySource {
        id: "opencode-bench".into(),
        kind: AgentKind::OpenCode,
        root,
        enabled: true,
    };
    let started = std::time::Instant::now();
    let status = catalog
        .sync(
            std::slice::from_ref(&source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    println!(
        "elapsed_ms={} errors={:?}",
        started.elapsed().as_millis(),
        status.errors
    );
}
