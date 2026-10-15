//! Reproducible synthetic benchmark; never reads real Agent history.
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource, SessionQuery},
};
use std::{fs, io::Write, sync::atomic::AtomicBool, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let count: usize = std::env::args().nth(1).unwrap_or("1000".into()).parse()?;
    let kib: usize = std::env::args().nth(2).unwrap_or("100".into()).parse()?;
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("codex");
    let histories = root.join("sessions");
    fs::create_dir_all(&histories)?;
    let text = "Implementation detail with 中文測試 and session_bay_identifier. "
        .repeat((kib * 1024 / 64).max(1));
    let mut source_bytes = 0u64;
    for i in 0..count {
        let path = histories.join(format!("session-{i}.jsonl"));
        let mut file = fs::File::create(&path)?;
        writeln!(
            file,
            "{}",
            serde_json::json!({"timestamp":"2026-10-15T00:00:00Z","type":"session_meta","payload":{"id":format!("session-{i}"),"cwd":"/synthetic/project"}})
        )?;
        writeln!(
            file,
            "{}",
            serde_json::json!({"timestamp":"2026-10-15T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("Task {i}")} ]}})
        )?;
        writeln!(
            file,
            "{}",
            serde_json::json!({"timestamp":"2026-10-15T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("{text} unique_needle_{i}")} ]}})
        )?;
        source_bytes += file.metadata()?.len();
    }
    let catalog = Catalog::open(&temp.path().join("catalog.sqlite"))?;
    let sources = vec![HistorySource {
        id: "benchmark".into(),
        kind: AgentKind::Codex,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    }];
    let begin = Instant::now();
    let status = catalog.sync(&sources, &AtomicBool::new(false), |_| {})?;
    let indexing_ms = begin.elapsed().as_secs_f64() * 1000.;
    let begin = Instant::now();
    catalog.sync(&sources, &AtomicBool::new(false), |_| {})?;
    let reconcile_ms = begin.elapsed().as_secs_f64() * 1000.;
    let mut reports = vec![];
    for query in [
        "中文",
        "session_bay_identifier",
        "SESSION_BAY_IDENTIFIER",
        "unique_needle_999",
        "no_match_exists",
    ] {
        let request = SessionQuery {
            query: Some(query.into()),
            limit: Some(50),
            ..Default::default()
        };
        catalog.query(&request)?;
        let mut times = vec![];
        let mut total = 0;
        for _ in 0..20 {
            let begin = Instant::now();
            total = catalog.query(&request)?.total;
            times.push(begin.elapsed().as_secs_f64() * 1000.);
        }
        times.sort_by(f64::total_cmp);
        reports.push(serde_json::json!({"query":query,"matches":total,"samples":times.len(),"p50Ms":times[10],"p95Ms":times[18]}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"sessions":count,"sourceBytes":source_bytes,"indexingMs":indexing_ms,"unchangedReconcileMs":reconcile_ms,"indexErrors":status.errors,"search":reports})
        )?
    );
    Ok(())
}
