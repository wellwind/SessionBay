//! Synthetic SQLite only; never opens the user's catalog or agent histories.
#[path = "../tests/support/paging_fixture.rs"]
mod paging_fixture;
use sessionbay_lib::models::SessionQuery;
use std::time::Instant;

fn main() {
    let start = Instant::now();
    let (_dir, catalog, _conn) = paging_fixture::fixture(10_000);
    println!(
        "synthetic SQLite: 10000 sessions/files/messages; seed_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.
    );
    for oldest in [false, true] {
        for offset in [0, 40, 1000, 5000, 9960] {
            let mut counts = Vec::new();
            let mut pages = Vec::new();
            let mut totals = Vec::new();
            for _ in 0..21 {
                let start = Instant::now();
                let (page, timings) = catalog
                    .query_profiled(&SessionQuery {
                        offset: Some(offset),
                        limit: Some(40),
                        oldest_first: Some(oldest),
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(page.items.len(), 40);
                assert_eq!(page.total, 10_000);
                counts.push(timings.iter().find(|(name, _)| *name == "count").unwrap().1);
                pages.push(timings.iter().find(|(name, _)| *name == "page").unwrap().1);
                totals.push(start.elapsed().as_secs_f64() * 1000.);
            }
            counts.sort_by(f64::total_cmp);
            pages.sort_by(f64::total_cmp);
            totals.sort_by(f64::total_cmp);
            println!("oldest={oldest} offset={offset} n=21 count_median_ms={:.3} page_median_ms={:.3} total_median_ms={:.3} total_p95_ms={:.3}", counts[10],pages[10],totals[10],totals[19]);
        }
    }
}
