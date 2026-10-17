//! Separate synthetic search benchmark; never opens real histories.
//! Usage: search_benchmark prepare DIRECTORY [SESSIONS] | run DIRECTORY [SAMPLES]
use serde_json::{json, Value};
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource, SessionQuery},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self},
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("Expected prepare or run")?;
    let directory = Path::new(args.get(2).ok_or("Expected synthetic dataset directory")?);
    if mode == "prepare" {
        // Refuse reuse: this command must never overwrite existing data.
        fs::create_dir(directory)?;
        let count: usize = args.get(3).map(String::as_str).unwrap_or("10000").parse()?;
        if !(1..=100000).contains(&count) {
            return Err("Expected 1..100000 sessions".into());
        }
        let root = directory.join("codex");
        let histories = root.join("sessions");
        fs::create_dir_all(&histories)?;
        let sentence = "Implementation detail 中文測試 session_bay_identifier. ";
        let payload = sentence.repeat(200 * 1024 / 40 / sentence.len());
        for i in 0..count {
            let mut file = fs::File::create(histories.join(format!("session-{i}.jsonl")))?;
            writeln!(
                file,
                "{}",
                json!({"timestamp":"2026-10-16T00:00:00Z","type":"session_meta","payload":{"id":format!("session-{i}"),"title":format!("Synthetic conversation {i}"),"cwd":"/synthetic/project"}})
            )?;
            for j in 0..40 {
                let text = format!("Session {i} message {j}. {payload} unique_needle_{i}.");
                file.write_all(
                    record(if j % 2 == 0 { "user" } else { "assistant" }, &text, false).as_bytes(),
                )?;
            }
        }
        let before = manifest(&histories)?;
        let catalog = Catalog::open(&directory.join("catalog.sqlite"))?;
        let start = Instant::now();
        let status = catalog.sync(
            &[HistorySource {
                id: "benchmark".into(),
                kind: AgentKind::Codex,
                root: root.to_string_lossy().into_owned(),
                enabled: true,
            }],
            &AtomicBool::new(false),
            |_| {},
        )?;
        let indexing_ms = start.elapsed().as_secs_f64() * 1000.;
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!(
            manifest(&histories)?,
            before,
            "Source files must remain read-only"
        );
        let data = json!({"sessions":count,"messagesPerSession":40,"sourceSha256":before.0,"sourceBytes":before.1,"indexingMs":indexing_ms,"memory":memory()});
        fs::write(
            directory.join("synthetic-manifest.json"),
            serde_json::to_string_pretty(&data)?,
        )?;
        println!("{}", serde_json::to_string_pretty(&data)?);
    } else if mode == "run" {
        let data: Value =
            serde_json::from_slice(&fs::read(directory.join("synthetic-manifest.json"))?)?;
        let samples: usize = args.get(3).map(String::as_str).unwrap_or("20").parse()?;
        if !(2..=1000).contains(&samples) {
            return Err("Expected 2..1000 samples".into());
        }
        let catalog = Catalog::open(&directory.join("catalog.sqlite"))?;
        let mut reports = Vec::new();
        for (query, offset, limit, kind, project) in [
            ("session_bay_identifier", 0, 50, None, None),
            ("SESSION_BAY_IDENTIFIER", 0, 50, None, None),
            ("中文", 0, 50, None, None),
            ("中文測試", 0, 50, None, None),
            ("unique_needle_0.", 0, 50, None, None),
            ("no_match_exists", 0, 50, None, None),
            ("100%_literal\\", 0, 50, None, None),
            ("session_bay_identifier", 9950, 50, None, None),
            (
                "session_bay_identifier",
                0,
                200,
                Some(AgentKind::Codex),
                None,
            ),
            (
                "session_bay_identifier",
                0,
                50,
                Some(AgentKind::Claude),
                None,
            ),
            (
                "session_bay_identifier",
                0,
                50,
                None,
                Some("missing-project"),
            ),
        ] {
            let request = SessionQuery {
                query: Some(query.into()),
                offset: Some(offset),
                limit: Some(limit),
                kind,
                project_id: project.map(str::to_owned),
                ..Default::default()
            };
            let start = Instant::now();
            let (first, first_phases) = catalog.query_profiled(&request)?;
            let first_ms = start.elapsed().as_secs_f64() * 1000.;
            let expected = serde_json::to_value(&first)?;
            let mut timings = Vec::new();
            let mut raw = Vec::new();
            for _ in 0..samples {
                let start = Instant::now();
                let (page, phases) = catalog.query_profiled(&request)?;
                let ms = start.elapsed().as_secs_f64() * 1000.;
                assert_eq!(serde_json::to_value(&page)?, expected);
                timings.push(ms);
                raw.push(json!({"milliseconds":ms,"phasesMs":phases.into_iter().map(|(k,v)| (k.to_owned(),json!(v))).collect::<serde_json::Map<_,_>>(),"memory":memory()}));
            }
            timings.sort_by(f64::total_cmp);
            let result = json!({"request":request,"matches":first.total,"returned":first.items.len(),"resultSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&first)?)),"firstQueryMs":first_ms,"firstPhasesMs":first_phases.into_iter().map(|(k,v)| (k.to_owned(),json!(v))).collect::<serde_json::Map<_,_>>(),"p50Ms":timings[(samples-1)/2],"p95Ms":timings[(samples*95).div_ceil(100)-1],"raw":raw});
            eprintln!(
                "{query} offset={offset} p95={:.3} ms",
                timings[(samples * 95).div_ceil(100) - 1]
            );
            reports.push(result);
        }
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"dataset":data,"samplesPerQuery":samples,"search":reports,"memory":memory(),"scope":"Backend search only; existing index; each query opens a fresh SQLite connection. First query is not OS-cold. Warm samples follow one unmeasured-for-percentiles query; OS page cache is uncontrolled; process peak includes all queries."})
            )?
        );
    } else {
        return Err("Expected prepare or run".into());
    }
    Ok(())
}
