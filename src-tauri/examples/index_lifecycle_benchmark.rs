//! Synthetic, reproducible index lifecycle benchmark. Never opens real histories.
//! Usage: index_lifecycle_benchmark SESSIONS KIB_PER_SESSION MESSAGES [duplicates]
use serde_json::{json, Value};
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource, SessionQuery},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::AtomicBool,
    time::Instant,
};

fn memory() -> Value {
    // RSS is a Linux sample; the high-water mark is process-wide on Unix.
    // Unsupported measurements are null, not fabricated comparable values.
    let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status.lines().find_map(|line| {
            line.strip_prefix(name)
                .and_then(|value| value.split_whitespace().next()?.parse::<u64>().ok())
        })
    };
    #[cfg(unix)]
    let peak = {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // getrusage initializes the complete structure when it succeeds.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
            let value = unsafe { usage.assume_init() }.ru_maxrss as u64;
            Some(if cfg!(target_os = "macos") {
                value / 1024
            } else {
                value
            })
        } else {
            None
        }
    };
    #[cfg(not(unix))]
    let peak: Option<u64> = None;
    json!({"residentKiB": field("VmRSS:"), "processPeakResidentKiB": peak})
}

fn record(role: &str, text: &str, duplicate: bool) -> String {
    if duplicate {
        format!(
            "{}\n",
            json!({"timestamp":"2026-10-16T00:00:01Z","type":"event_msg","payload":{"type":if role == "user" {"user_message"} else {"agent_message"},"message":text}})
        )
    } else {
        format!(
            "{}\n",
            json!({"timestamp":"2026-10-16T00:00:01Z","type":"response_item","payload":{"type":"message","role":role,"content":[{"type":if role == "user" {"input_text"} else {"output_text"},"text":text}]}})
        )
    }
}

fn manifest(root: &Path) -> Result<(String, u64), Box<dyn std::error::Error>> {
    let mut paths = fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 64 * 1024];
    for path in paths {
        // Generated filenames are fixed and non-sensitive; no temp path in output.
        digest.update(path.file_name().unwrap().as_encoded_bytes());
        let mut file = fs::File::open(path)?;
        loop {
            let length = file.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
            bytes += length as u64;
        }
    }
    Ok((format!("{:x}", digest.finalize()), bytes))
}

fn sync(name: &str, catalog: &Catalog, sources: &[HistorySource]) -> Result<Value, String> {
    let begin = Instant::now();
    let status = catalog.sync(sources, &AtomicBool::new(false), |_| {})?;
    let elapsed = begin.elapsed().as_secs_f64() * 1000.;
    if !status.errors.is_empty() || status.cancelled {
        return Err(format!("{name}: {status:?}"));
    }
    eprintln!("{name}: {elapsed:.2} ms");
    Ok(json!({"phase":name,"milliseconds":elapsed,"processed":status.processed,"memory":memory()}))
}

fn matches(catalog: &Catalog, query: &str) -> Result<u64, String> {
    Ok(catalog
        .query(&SessionQuery {
            query: Some(query.into()),
            limit: Some(50),
            ..Default::default()
        })?
        .total)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let count: usize = args.get(1).map(String::as_str).unwrap_or("1000").parse()?;
    let kib: usize = args.get(2).map(String::as_str).unwrap_or("100").parse()?;
    let messages: usize = args.get(3).map(String::as_str).unwrap_or("20").parse()?;
    let duplicates = args.get(4).is_some_and(|arg| arg == "duplicates");
    if !(1..=100_000).contains(&count)
        || !(2..=100_000).contains(&messages)
        || !(1..=131_072).contains(&kib)
    {
        return Err(
            "Expected 1..100000 sessions, 1..131072 KiB/session, 2..100000 messages.".into(),
        );
    }
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("codex");
    let histories = root.join("sessions");
    fs::create_dir_all(&histories)?;
    let sentence = "Implementation detail 中文測試 session_bay_identifier. ";
    let payload = sentence.repeat((kib * 1024 / messages / sentence.len()).max(1));
    for i in 0..count {
        let mut file = fs::File::create(histories.join(format!("session-{i}.jsonl")))?;
        writeln!(
            file,
            "{}",
            json!({"timestamp":"2026-10-16T00:00:00Z","type":"session_meta","payload":{"id":format!("session-{i}"),"title":format!("Synthetic conversation {i}"),"cwd":"/synthetic/project"}})
        )?;
        for j in 0..messages {
            let role = if j % 2 == 0 { "user" } else { "assistant" };
            let text = format!("Session {i} message {j}. {payload} unique_needle_{i}.");
            if duplicates {
                file.write_all(record(role, &text, true).as_bytes())?;
            }
            file.write_all(record(role, &text, false).as_bytes())?;
        }
    }
    let original = manifest(&histories)?;
    let catalog = Catalog::open(&temp.path().join("catalog.sqlite"))?;
    let sources = vec![HistorySource {
        id: "benchmark".into(),
        kind: AgentKind::Codex,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    }];
    let mut phases = vec![sync("coldIndex", &catalog, &sources)?];
    for _ in 0..3 {
        phases.push(sync("unchangedReconcile", &catalog, &sources)?);
    }
    assert_eq!(catalog.query(&SessionQuery::default())?.total, count as u64);
    assert_eq!(
        manifest(&histories)?,
        original,
        "Scans must not modify sources"
    );
    let changed = histories.join("session-0.jsonl");
    let mut file = OpenOptions::new().append(true).open(&changed)?;
    file.write_all(record("user", "APPEND_BENCHMARK_SENTINEL", false).as_bytes())?;
    drop(file);
    phases.push(sync("singleFileAppend", &catalog, &sources)?);
    assert_eq!(matches(&catalog, "APPEND_BENCHMARK_SENTINEL")?, 1);
    // Same-size in-place rewrite must replace old searchable content.
    let rewritten = fs::read_to_string(&changed)?
        .replace("APPEND_BENCHMARK_SENTINEL", "REWRIT_BENCHMARK_SENTINEL");
    fs::write(&changed, rewritten)?;
    let expected = manifest(&histories)?;
    phases.push(sync("sameSizeRewrite", &catalog, &sources)?);
    assert_eq!(matches(&catalog, "APPEND_BENCHMARK_SENTINEL")?, 0);
    assert_eq!(matches(&catalog, "REWRIT_BENCHMARK_SENTINEL")?, 1);
    assert_eq!(
        manifest(&histories)?,
        expected,
        "Scans must not modify sources"
    );
    let conn = rusqlite::Connection::open(temp.path().join("catalog.sqlite"))?;
    let visible: u64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE hidden=0 AND search_text<>''",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        visible,
        (count * messages + 1) as u64,
        "Fallback copies must not become duplicate visible messages"
    );
    drop(conn);
    let mut search = Vec::new();
    for query in [
        "中文",
        "session_bay_identifier",
        "SESSION_BAY_IDENTIFIER",
        "unique_needle_0.",
        "no_match_exists",
    ] {
        matches(&catalog, query)?;
        let mut samples = Vec::new();
        let mut total = 0;
        for _ in 0..20 {
            let begin = Instant::now();
            total = matches(&catalog, query)?;
            samples.push(begin.elapsed().as_secs_f64() * 1000.);
        }
        samples.sort_by(f64::total_cmp);
        search.push(json!({"query":query,"matches":total,"samples":20,"p50Ms":samples[9],"p95Ms":samples[18]}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "version":1,"sessions":count,"requestedKiBPerSession":kib,"logicalMessagesPerSession":messages,
            "fallbackDuplicates":duplicates,"sourceBytes":original.1,"sourceSha256":original.0,
            "phases":phases,"search":search,"finalMemory":memory(),
            "scope":"release backend only; fresh index with OS page cache warm from synthetic generation; source integrity checks excluded from timings; memory is process-wide and includes generation"
        }))?
    );
    Ok(())
}
