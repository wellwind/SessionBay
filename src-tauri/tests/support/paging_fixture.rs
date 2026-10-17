use rusqlite::{params, Connection};
use sessionbay_lib::catalog::Catalog;
use tempfile::TempDir;

pub fn fixture(count: usize) -> (TempDir, Catalog, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.sqlite");
    let catalog = Catalog::open(&path).unwrap();
    let mut conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO sources VALUES('synthetic','codex',?1,1,?1)",
        [dir.path().to_str().unwrap()],
    )
    .unwrap();
    tx.execute_batch("INSERT INTO projects(id,name) VALUES('synthetic','Synthetic paging');")
        .unwrap();
    for i in 0..count {
        let id = format!("session-{i:05}");
        tx.execute("INSERT INTO sessions(id,source_id,kind,external_id,project_id,title,updated_at,time_source,archived,partial) VALUES(?1,'synthetic','codex',?1,'synthetic',?1,strftime('%Y-%m-%dT%H:%M:%SZ','2026-01-01',?2||' seconds'),'event',0,0)", params![id,i as i64]).unwrap();
        tx.execute("INSERT INTO files(id,source_id,path,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived) VALUES(?1,'synthetic',?2,?2,'synthetic',100,'synthetic',100,1,'synthetic',1,'ready',0)", params![i as i64+1,id]).unwrap();
        tx.execute("INSERT INTO messages(file_id,line,byte_offset,byte_len,role,search_text) VALUES(?1,1,0,100,'user','Synthetic paging benchmark message')", [i as i64+1]).unwrap();
    }
    tx.commit().unwrap();
    (dir, catalog, conn)
}
