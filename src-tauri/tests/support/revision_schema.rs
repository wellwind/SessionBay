// These tests deliberately reconstruct older schemas before opening migrations.
pub fn remove_revision_schema(conn: &rusqlite::Connection) {
    let names = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_%'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for name in names {
        conn.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    conn.execute_batch("DROP TABLE catalog_revision; DROP INDEX sessions_oldest; DROP INDEX sessions_project_oldest;").unwrap();
}
