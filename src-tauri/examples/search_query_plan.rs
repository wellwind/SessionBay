//! Diagnostic only: compare equivalent count-query plans on an existing synthetic index.
//! Usage: search_query_plan SYNTHETIC_DATASET_DIRECTORY
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::Path, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arg = std::env::args()
        .nth(1)
        .ok_or("Expected synthetic dataset directory")?;
    let root = Path::new(&arg);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("synthetic-manifest.json"))?)?;
    let conn = Connection::open_with_flags(
        root.join("catalog.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let query = "session_bay_identifier";
    let terms = query
        .as_bytes()
        .windows(3)
        .map(|w| format!("\"{}\"", std::str::from_utf8(w).unwrap()))
        .collect::<Vec<_>>()
        .join(" AND ");
    let values = [query, query, "%session\\_bay\\_identifier%", &terms];
    let literal = |column: &str| {
        format!("(CASE WHEN {column} LIKE ?3 ESCAPE '\\' THEN 1 WHEN instr({column},char(0))>0 THEN instr(lower({column}),?2)>0 ELSE 0 END)")
    };
    let title = literal("s.title");
    let body = literal("m.search_text");
    let variants = [
        ("baseline", format!("SELECT COUNT(*) FROM sessions s WHERE s.child=0 AND ({title} OR s.id IN (SELECT f.session_id FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN files f ON f.id=m.file_id WHERE messages_fts MATCH ?4 AND m.hidden=0 AND {body}))")),
        ("existsWithCandidates", format!("SELECT COUNT(*) FROM sessions s WHERE s.child=0 AND ({title} OR EXISTS(SELECT 1 FROM files f CROSS JOIN messages m ON m.file_id=f.id WHERE f.session_id=s.id AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?4) AND m.hidden=0 AND {body}))")),
    ];
    let mut result = Vec::new();
    for (name, sql) in variants {
        let plan = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
            .query_map(values, |row| row.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut samples = Vec::new();
        for _ in 0..3 {
            let io_before = fs::read_to_string("/proc/self/io").ok();
            let start = Instant::now();
            let total: u64 = conn.query_row(&sql, values, |row| row.get(0))?;
            let ms = start.elapsed().as_secs_f64() * 1000.;
            assert_eq!(Some(total), manifest["sessions"].as_u64());
            samples.push(json!({"milliseconds":ms,"total":total,"processIoBefore":io_before,"processIoAfter":fs::read_to_string("/proc/self/io").ok()}));
        }
        eprintln!("{name}: {}", serde_json::to_string(&samples)?);
        result.push(json!({"name":name,"sql":sql,"queryPlan":plan,"samples":samples}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"sqliteVersion":rusqlite::version(),"variants":result})
        )?
    );
    Ok(())
}
