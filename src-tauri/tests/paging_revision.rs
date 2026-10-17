#[path = "support/paging_fixture.rs"]
mod paging_fixture;
use sessionbay_lib::models::SessionQuery;

#[test]
fn cross_batch_delete_insert_and_sort_changes_invalidate_offsets() {
    for mutation in [
        "DELETE FROM sessions WHERE id='session-00075'",
        "INSERT INTO sessions SELECT 'inserted',source_id,kind,'inserted',project_id,title,cwd,'2027-01-01T00:00:00Z',time_source,archived,parent_id,child,partial FROM sessions LIMIT 1",
        "UPDATE sessions SET updated_at='2027-01-01T00:00:00Z' WHERE id='session-00020'",
    ] {
        let (_dir, catalog, conn) = paging_fixture::fixture(85);
        let query = SessionQuery { limit: Some(40), ..Default::default() };
        let first = catalog.query(&query).unwrap();
        conn.execute_batch(mutation).unwrap();
        let second = catalog.query(&SessionQuery { offset: Some(40), ..query.clone() }).unwrap();
        assert_ne!(first.catalog_revision, second.catalog_revision);
        let reset = catalog.query(&query).unwrap();
        assert_eq!(reset.catalog_revision, second.catalog_revision);
        let all = catalog.query(&SessionQuery { limit: Some(200), ..query }).unwrap();
        let combined: Vec<_> = reset.items.iter().chain(second.items.iter()).map(|s| &s.id).collect();
        assert_eq!(combined, all.items.iter().take(80).map(|s| &s.id).collect::<Vec<_>>());
    }
}

#[test]
fn committed_revision_is_visible_before_indexing_finishes_and_rollback_does_not_advance_it() {
    let (_dir, catalog, mut conn) = paging_fixture::fixture(85);
    let before = catalog.query(&SessionQuery::default()).unwrap();
    conn.execute("UPDATE sessions SET title=title", []).unwrap();
    assert_eq!(
        catalog.revision().unwrap().to_string(),
        before.catalog_revision
    );
    let tx = conn.transaction().unwrap();
    tx.execute("DELETE FROM sessions WHERE id='session-00075'", [])
        .unwrap();
    // A WAL reader still observes the last committed rows and revision.
    let during = catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(before.catalog_revision, during.catalog_revision);
    assert_eq!(during.total, 85);
    tx.rollback().unwrap();
    assert_eq!(
        catalog.revision().unwrap().to_string(),
        before.catalog_revision
    );
    conn.execute("DELETE FROM sessions WHERE id='session-00075'", [])
        .unwrap();
    let committed = catalog.query(&SessionQuery::default()).unwrap();
    assert_ne!(committed.catalog_revision, before.catalog_revision);
    assert_eq!(committed.total, 84);
    // No scan-completion call is necessary to invalidate another page, including
    // a now-empty tail that must not be used to finish the old feed.
    conn.execute("DELETE FROM sessions", []).unwrap();
    let tail = catalog
        .query(&SessionQuery {
            offset: Some(40),
            ..Default::default()
        })
        .unwrap();
    assert_ne!(tail.catalog_revision, committed.catalog_revision);
    assert!(tail.items.is_empty());
    assert_eq!(tail.total, 0);
}

#[test]
fn trash_and_rebuild_share_the_catalog_revision() {
    let (_dir, catalog, conn) = paging_fixture::fixture(2);
    let before = catalog.trashed_sessions(0, 40).unwrap();
    conn.execute("UPDATE sessions SET title='changed'", [])
        .unwrap();
    let after = catalog.trashed_sessions(0, 40).unwrap();
    assert_ne!(before.catalog_revision, after.catalog_revision);
    assert_eq!(
        after.catalog_revision,
        catalog
            .query(&SessionQuery::default())
            .unwrap()
            .catalog_revision
    );
    catalog.clear().unwrap();
    assert_ne!(
        after.catalog_revision,
        catalog
            .query(&SessionQuery::default())
            .unwrap()
            .catalog_revision
    );
}

#[test]
fn recycle_bin_cross_batch_removal_changes_the_snapshot_token() {
    let (dir, catalog, mut conn) = paging_fixture::fixture(85);
    let sessions = catalog
        .query(&SessionQuery {
            limit: Some(200),
            ..Default::default()
        })
        .unwrap();
    let tx = conn.transaction().unwrap();
    for (i, session) in sessions.items.iter().enumerate() {
        tx.execute(
            "INSERT INTO session_trash VALUES(?1,?2,?3,?4,'2026-01-01T00:00:00Z')",
            rusqlite::params![
                format!("trash-{i:05}"),
                session.id,
                serde_json::to_string(session).unwrap(),
                dir.path().to_str().unwrap()
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let before = catalog.trashed_sessions(0, 40).unwrap();
    conn.execute("DELETE FROM session_trash WHERE id='trash-00010'", [])
        .unwrap();
    let tail = catalog.trashed_sessions(40, 40).unwrap();
    assert_ne!(tail.catalog_revision, before.catalog_revision);
    let reset = catalog.trashed_sessions(0, 40).unwrap();
    assert_eq!(tail.catalog_revision, reset.catalog_revision);
    assert_eq!(reset.total, 84);
    assert_eq!(reset.items.last().unwrap().id, "trash-00040");
    assert_eq!(tail.items.first().unwrap().id, "trash-00041");
}
