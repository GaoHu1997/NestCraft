//! Real disk files + SQLite publication + actual verified gateway, no closure authorization mock.
use super::*;
use super::super::verified;
/// 快照租约、构建槽与游标账本都是进程级全局状态（`RUNTIME`），并行测试共享同一份
/// 配额（64 租约 / 32 每 owner / 单构建槽），会互相顶掉成 `LEASE_QUOTA`、`BUSY_RETRY`。
/// 测试必须串行占用这一份全局状态；产品行为不变（单进程本来就只有一份运行时）。
///
/// 用「重入计数」而不是普通 Mutex：部分测试在同一线程内创建两个 Fixture，
/// 普通锁会自死锁。这里按线程记录持有深度，只有第一次进入才真正等待。
static SNAPSHOT_SERIAL: std::sync::Mutex<SNAPSHOT_SERIAL_STATE> =
    std::sync::Mutex::new(SNAPSHOT_SERIAL_STATE { holder: None, depth: 0 });

#[derive(Default)]
struct SNAPSHOT_SERIAL_STATE { holder: Option<std::thread::ThreadId>, depth: usize }

struct SerialGuard { first: bool }
impl SerialGuard {
    fn acquire() -> Self {
        let me = std::thread::current().id();
        // poison 恢复：某个测试失败不应让其余测试全部连锁失败。
        let mut state = SNAPSHOT_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        match state.holder {
            Some(owner) if owner == me => { state.depth += 1; Self { first: false } }
            _ => {
                drop(state);
                // 其他线程持有时等待；拿到后再抢一次确认深度。
                loop {
                    let mut state = SNAPSHOT_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
                    if state.holder.is_none() || state.holder == Some(me) {
                        state.holder = Some(me);
                        state.depth += 1;
                        break;
                    }
                    drop(state);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Self { first: true }
            }
        }
    }
}
impl Drop for SerialGuard {
    fn drop(&mut self) {
        let me = std::thread::current().id();
        if let Ok(mut state) = SNAPSHOT_SERIAL.lock() {
            if state.holder == Some(me) {
                state.depth = state.depth.saturating_sub(1);
                if state.depth == 0 { state.holder = None; }
            }
        }
        let _ = self.first;
    }
}

struct Fixture {conn:Connection,work:PathBuf,root:PathBuf,lib:String,_serial:SerialGuard}
impl Fixture {
    fn new()->Self {
        let serial = SerialGuard::acquire();
        let work=std::env::temp_dir().join(new_id("nc-formal-test"));fs::create_dir_all(work.join("source")).unwrap();
        let root=fs::canonicalize(work.join("source")).unwrap();let conn=Connection::open(work.join("test.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceRef TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,sourceKind TEXT NOT NULL DEFAULT 'managed-directory'); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT); CREATE INDEX legacy_lookup ON knowledge_note_index(libraryId,relativeUri); CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,revision INTEGER, PRIMARY KEY(projectId,libraryId));").unwrap();
        let lib=new_id("formal-lib");conn.execute("INSERT INTO knowledge_library(id,name,sourceRef) VALUES(?1,'fixture',?2)",params![lib,root.to_string_lossy()]).unwrap();
        performance::migrate(&conn).unwrap();migrate(&conn).unwrap();conn.execute("INSERT INTO project_library_grant VALUES('p',?1,1,1)",[&lib]).unwrap();
        Self{conn,work,root,lib,_serial:serial}
    }
    fn write(&self,name:&str,body:impl AsRef<[u8]>){let p=self.root.join(name);fs::create_dir_all(p.parent().unwrap()).unwrap();fs::write(p,body).unwrap();}
    fn spec(&self,engine:Engine)->BuildSpec{begin_build_engine(&self.conn,"formal-owner",&self.lib,&new_id("req"),engine).unwrap()}
    fn limits()->Limits{Limits{logical_bytes:128*1024*1024,disk_bytes:u64::MAX,check_space:false}}
    fn build(&self,engine:Engine)->BuildSpec{let s=self.spec(engine);build_snapshot(&self.conn,&s,&AtomicBool::new(false),&Self::limits()).unwrap();s}
    fn search(&self,q:&str)->(Vec<RawHit>,bool){search_library(&self.conn,&self.lib,&kb_index::parse_query(q).unwrap()).unwrap().unwrap()}
    fn note(&self,g:i64,path:&str)->String{self.conn.query_row("SELECT noteId FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND relativeUri=?3",params![self.lib,g,path],|r|r.get(0)).unwrap()}
}
impl Drop for Fixture {fn drop(&mut self){if let Ok(mut stmt)=self.conn.prepare("SELECT id FROM kb_snap_generation WHERE libraryId=?1"){if let Ok(rows)=stmt.query_map([&self.lib],|r|r.get::<_,i64>(0)){for id in rows.flatten(){let _=tantivy_engine::forget(&self.conn,&self.lib,id);}}}let old=std::mem::replace(&mut self.conn,Connection::open_in_memory().unwrap());drop(old);let _=fs::remove_dir_all(&self.work);}}
#[test]
fn formal_migrate_twice_old_sqlite_cursor_lease_upgrade_and_rollback(){
    let f=Fixture::new();f.write("a.txt",format!("{}tail","old needle\r\n".repeat(300)));let old=f.build(Engine::Sqlite);
    let note=f.note(old.generation,"a.txt");let first=read_chunk_conn(&f.conn,&f.lib,&note,None,0,Some(37)).unwrap().unwrap();let cursor=first.next_cursor.unwrap();
    let lease=acquire_lease(&f.conn,"old-window",&f.lib,old.generation).unwrap();
    // Reconstitute the historical schema (no engine columns), retaining actual old rows/FTS.
    for name in ["engineKind","engineSchemaVersion","enginePath","engineFormat","engineOptionsHash"]{f.conn.execute_batch(&format!("ALTER TABLE kb_snap_generation DROP COLUMN {name}")).unwrap();}
    migrate(&f.conn).unwrap();migrate(&f.conn).unwrap();
    assert_eq!(f.conn.query_row("SELECT engineKind FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"sqlite");
    f.conn.execute("UPDATE kb_snap_member SET contextVersion=?2 WHERE generation=?1",params![old.generation,LEGACY_CONTEXT_VERSION]).unwrap();
    f.conn.execute("UPDATE kb_snap_chunk SET searchText=text||searchText WHERE createdGeneration=?1",[old.generation]).unwrap();
    let new=f.build(Engine::Tantivy);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(new.generation));
    assert_eq!(read_cursor_conn(&f.conn,&f.lib,&cursor,Some(37)).unwrap().parse_generation,first.parse_generation);
    assert!(!gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap());
    let no_dup:i64=f.conn.query_row("SELECT SUM(length(text)+length(searchText)) FROM kb_snap_chunk WHERE createdGeneration=?1",[new.generation],|r|r.get(0)).unwrap();assert_eq!(no_dup,0);
    release_lease("old-window",&lease).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    assert!(read_cursor_conn(&f.conn,&f.lib,&cursor,None).is_err());
    let rollback=f.build(Engine::Sqlite);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(rollback.generation));
    assert!(fs::read_to_string(f.root.join("a.txt")).unwrap().starts_with("old needle"));
}
#[test]
fn repairs_v2_r8_unchanged_tantivy_never_decodes_again(){
    let f=Fixture::new();f.write("a.txt","needle unchanged\r\n".repeat(5000));
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let old=f.build(Engine::Tantivy);
    assert_eq!(STAGE_STATS.with(|s|s.borrow().decode_calls),1,"first build must actually decode");
    let old_note=f.note(old.generation,"a.txt");
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let new=f.build(Engine::Tantivy);
    let actual=STAGE_STATS.with(|s|s.borrow().decode_calls);
    assert_eq!(actual,0,"unchanged source was decoded/reparsed rather than trusted-store reuse");
    let mut rebuilt=String::new();tantivy_engine::visit_primary(&f.conn,&f.lib,new.generation,|m,p|{assert_eq!(m.note,old_note);rebuilt.push_str(p);Ok(())}).unwrap();
    assert_eq!(rebuilt,"needle unchanged\r\n".repeat(5000));
}
#[test]
fn repairs_v2_r8_only_changed_file_decodes_and_new_store_outlives_old_gc(){
    let f=Fixture::new();let a="needle stable\r\n".repeat(5000);let b="# heading\r\nΩ正文\r\n".repeat(40);
    f.write("a.txt",&a);f.write("b.md",[vec![0xff,0xfe],b.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat());f.write("c.bin",[1,2,3,4]);
    f.conn.execute("INSERT INTO knowledge_note_index VALUES(?1,'stable-a','old title','a.txt','')",[&f.lib]).unwrap();
    let old=f.build(Engine::Tantivy);let lease=acquire_lease(&f.conn,"old-human-window",&f.lib,old.generation).unwrap();
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let same=f.build(Engine::Tantivy);
    assert_eq!(STAGE_STATS.with(|s|(s.borrow().decode_calls,s.borrow().reused_files)),(0,3));
    let mut texts=HashMap::<String,String>::new();tantivy_engine::visit_primary(&f.conn,&f.lib,same.generation,|m,p|{assert_eq!(m.generation,same.generation);texts.entry(m.relative_uri.clone()).or_default().push_str(p);Ok(())}).unwrap();
    assert_eq!(texts["a.txt"],a);assert_eq!(texts["b.md"],b);
    let duplicated:i64=f.conn.query_row("SELECT COALESCE(SUM(length(text)+length(searchText)),0) FROM kb_snap_chunk WHERE createdGeneration=?1",[same.generation],|r|r.get(0)).unwrap();assert_eq!(duplicated,0);
    let old_parse:String=f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1 AND noteId='stable-a'",[old.generation],|r|r.get(0)).unwrap();
    let new_parse:String=f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1 AND noteId='stable-a'",[same.generation],|r|r.get(0)).unwrap();assert_ne!(old_parse,new_parse);
    assert!(!gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap());assert!(read_piece(&f.conn,&f.lib,"stable-a",old.generation,0,0,Some(37),false).is_ok());
    release_lease("old-human-window",&lease).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    assert!(read_piece(&f.conn,&f.lib,"stable-a",old.generation,0,0,Some(37),false).is_err());assert!(!f.search("needle").0.is_empty());
    f.write("b.md","changedbody Ω\r\n");STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let changed=f.build(Engine::Tantivy);
    assert_eq!(STAGE_STATS.with(|s|(s.borrow().decode_calls,s.borrow().reused_files)),(1,2));assert_eq!(f.search("changedbody").0[0].snapshot_generation,Some(changed.generation));
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    fs::rename(f.root.join("a.txt"),f.root.join("newpathneedle.txt")).unwrap();
    f.conn.execute("UPDATE knowledge_note_index SET title='newtitleneedle',relativeUri='newpathneedle.txt' WHERE libraryId=?1 AND noteId='stable-a'",[&f.lib]).unwrap();
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let renamed=f.build(Engine::Tantivy);
    assert_eq!(STAGE_STATS.with(|s|(s.borrow().decode_calls,s.borrow().reused_files)),(0,3));
    for q in ["newpathneedle","newtitleneedle","needle"]{assert!(f.search(q).0.iter().any(|h|h.note_id=="stable-a"&&h.relative_uri=="newpathneedle.txt"&&h.title=="newtitleneedle"&&h.snapshot_generation==Some(renamed.generation)));}
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let rollback=f.build(Engine::Sqlite);
    assert_eq!(STAGE_STATS.with(|s|(s.borrow().decode_calls,s.borrow().reused_files)),(0,3));assert_eq!(f.search("changedbody").0[0].snapshot_generation,Some(rollback.generation));
}
#[test]
fn repairs_v2_r8_sqlite_upgrade_copies_without_decode_or_sql_double_storage(){
    let f=Fixture::new();let body="needle upgrade\r\n".repeat(5000);f.write("a.txt",&body);let old=f.build(Engine::Sqlite);
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let new=f.build(Engine::Tantivy);
    assert_eq!(STAGE_STATS.with(|s|(s.borrow().decode_calls,s.borrow().reused_files)),(0,1));
    let mut got=String::new();tantivy_engine::visit_primary(&f.conn,&f.lib,new.generation,|_,p|{got.push_str(p);Ok(())}).unwrap();assert_eq!(got,body);
    let n:i64=f.conn.query_row("SELECT SUM(length(text)+length(searchText)) FROM kb_snap_chunk WHERE createdGeneration=?1",[new.generation],|r|r.get(0)).unwrap();assert_eq!(n,0);
    assert_ne!(f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1",[new.generation],|r|r.get::<_,String>(0)).unwrap());
}
#[test]
fn repairs_v2_r8_incompatible_versions_parse_but_trusted_store_damage_never_falls_back(){
    for mode in ["rules","engine","seal","count"]{
        let f=Fixture::new();f.write("a.txt","needle one");f.write("b.txt","needle two");let old=f.build(Engine::Tantivy);
        match mode{
            "rules"=>{f.conn.execute("UPDATE kb_snap_member SET parserVersion='unknown-parser' WHERE generation=?1 AND relativeUri='a.txt'",[old.generation]).unwrap();},
            "engine"=>{f.conn.execute("UPDATE kb_snap_generation SET engineSchemaVersion=999 WHERE id=?1",[old.generation]).unwrap();},
            "seal"=>{tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();fs::write(tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap().join("sealed.json"),b"{}").unwrap();},
            "count"=>{f.conn.execute("UPDATE kb_snap_member SET chunkCount=chunkCount+1 WHERE generation=?1 AND relativeUri='a.txt'",[old.generation]).unwrap();},_=>unreachable!()
        }
        STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let new=f.spec(Engine::Tantivy);
        let result=build_snapshot(&f.conn,&new,&AtomicBool::new(false),&Fixture::limits());
        if mode=="rules"||mode=="engine"{result.unwrap();assert_eq!(STAGE_STATS.with(|s|s.borrow().decode_calls),if mode=="engine"{2}else{1});}
        else{let e=result.unwrap_err();assert!(e.contains(if mode=="seal"{"INDEX_SEAL_UNTRUSTED"}else{"INDEX_REUSE_COUNT_MISMATCH"}),"{mode}: {e}");assert_eq!(STAGE_STATS.with(|s|s.borrow().decode_calls),0);assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);}
    }
}
#[test]
fn repairs_v2_r8_copy_lease_blocks_gc_and_expired_lease_cannot_resurrect(){
    let f=Fixture::new();f.write("a.txt","needle old\r\n".repeat(5000));let old=f.build(Engine::Tantivy);let new=f.build(Engine::Tantivy);
    let note=f.note(old.generation,"a.txt");let parse:String=f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1",[old.generation],|r|r.get(0)).unwrap();let mut n=0;
    tantivy_engine::copy_member(&f.conn,&f.lib,old.generation,&note,&parse,&AtomicBool::new(false),|_,_,_|{if n==0{assert!(!gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap());}n+=1;Ok(())}).unwrap();assert!(n>32);
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!f.search("needle").0.is_empty());
    let parse:String=f.conn.query_row("SELECT parseGeneration FROM kb_snap_member WHERE generation=?1",[new.generation],|r|r.get(0)).unwrap();
    let e=tantivy_engine::copy_member(&f.conn,&f.lib,new.generation,&note,&parse,&AtomicBool::new(false),|_,_,_|{
        let mut rt=lock_runtime().unwrap();let lease=rt.leases.values_mut().find(|l|l.library==f.lib&&l.generation==new.generation&&l.owner=="internal-reader").unwrap();lease.touched=Instant::now()-LEASE_TTL-Duration::from_secs(1);Ok(())
    }).unwrap_err();assert!(e.contains("LEASE_EXPIRED"),"{e}");assert!(!lock_runtime().unwrap().leases.values().any(|l|l.library==f.lib));
}
#[test]
fn repairs_v2_r6_bounded_top100_precedes_physical_ties_and_segment_boundaries(){
    for(reverse,split)in [(false,false),(true,false),(true,true)]{
        let f=Fixture::new();let body="needle  ".repeat(CHUNK_BYTES/8*2);
        for i in 0..140{let name=format!("file-{i:03}.txt");f.write(&name,&body);f.conn.execute("INSERT INTO knowledge_note_index VALUES(?1,?2,'neutral',?3,'')",params![f.lib,format!("note-{i:03}"),name]).unwrap();}
        let s=f.spec(Engine::Tantivy);let cancel=AtomicBool::new(false);let limits=Fixture::limits();
        let mut builder=Builder{conn:&f.conn,spec:&s,cancel:&cancel,limits:&limits,fts:fts_name(s.generation).unwrap(),pending:Vec::new(),pending_bytes:0,logical:0,processed:0,files:0,chunks:0,last_progress:Instant::now(),disk:DiskGuard::new(),note:String::new(),parse:String::new(),title:String::new(),relative:String::new(),term_cache:None,engine_writer:Some(tantivy_engine::Writer::create(&f.conn,&s).unwrap()),source_hash:None};
        // Explicit fixture discovery order; all hashing/parsing/writing/publication
        // uses the real host components, not an alternate test engine.
        for n in 0..140{let i=if reverse{139-n}else{n};builder.file(&format!("file-{i:03}.txt")).unwrap();if split&&(n+1)%35==0{builder.engine_writer.as_mut().unwrap().split_segment_for_test().unwrap();}}
        builder.flush().unwrap();let(digest,count)=validate_manifest(&f.conn,&s,&cancel).unwrap();
        let ready=builder.engine_writer.take().unwrap().commit_monitored(&f.conn,&s,&cancel,&limits).unwrap();
        ready.validate(&f.conn,&s,builder.chunks,&cancel,&limits).unwrap();let seal=ready.seal(&f.conn,&s,&digest,&cancel,&limits).unwrap();
        publish(&f.conn,&s,&cancel,&digest,count,builder.chunks,builder.logical,Some(&seal)).unwrap();drop(ready);drop(builder);
        let q=kb_index::parse_query("needle").unwrap();let(expected,segments,physical)=tantivy_engine::rank_oracle_for_test(&f.conn,&f.lib,s.generation,&q).unwrap();
        assert!(expected.len()>101);if split{assert!(segments>=3,"multi-segment fixture collapsed: {segments}");}
        if reverse{assert!(physical.windows(2).any(|p|p[0]>p[1]),"reverse physical fixture was not exercised");}
        let(hits,incomplete)=f.search("needle");let actual:Vec<_>=hits.iter().map(|h|(h.score,h.note_id.clone(),h.ordinal,h.chunk_key)).collect();
        assert!(incomplete&&hits.len()==100);assert!(hits.iter().all(|h|h.score<0.0));
        assert_eq!(actual,expected[..100],"business top100 lost before tie sorting; reverse={reverse}, split={split}, segments={segments}");
    }
}
#[test]
fn repairs_v2_r6_old_tantivy_schema_explicitly_expires_without_guessing(){
    let f=Fixture::new();f.write("a.txt","needle source");let sqlite=f.build(Engine::Sqlite);let t=f.build(Engine::Tantivy);
    let sqlite_note=f.note(sqlite.generation,"a.txt");
    f.conn.execute("UPDATE kb_snap_generation SET engineSchemaVersion=1,engineFormat='nestcraft-tantivy-immutable-v1' WHERE id=?1",[t.generation]).unwrap();
    assert!(f.search_error("needle").contains("REBUILD_REQUIRED"),"old T version was guessed as current");
    assert!(read_piece(&f.conn,&f.lib,&sqlite_note,sqlite.generation,0,0,Some(37),false).is_ok());
}
#[test]
fn formal_literal_unicode_paths_mixed_single_han_quotes_and_ties(){
    let f=Fixture::new();f.write("deep/pathneedle.txt","中 beta Ω e\u{301} alpha AND quoted\r\n");f.write("tie-a.txt","identical");f.write("tie-b.txt","identical");
    f.build(Engine::Tantivy);
    for q in ["deep","deep/pathneedle","pathneedle","中","中 beta","ω","Ω","e\u{301}","\"alpha\" AND quoted*","alpha:AND quoted"]{assert!(!f.search(q).0.is_empty(),"{q}");}
    assert!(f.search("文 beta").0.is_empty());assert!(f.search("alpha OR quoted").0.is_empty());
    let hits=f.search("identical").0;assert_eq!(hits.len(),2);assert!(hits[0].score<0.0);assert!(hits[0].note_id<hits[1].note_id);
    assert!(f.search("missing").0.is_empty());
}
#[test]
fn formal_utf16_bom_crlf_cross_fourbyte_store_and_all_primary(){
    let f=Fixture::new();let needle="𠀀".repeat(128);let text=format!("{}{}\r\nΩ正文尾部","x".repeat(CHUNK_BYTES-4),needle);
    f.write("utf8.txt",[vec![0xef,0xbb,0xbf],text.as_bytes().to_vec()].concat());
    f.write("le.txt",[vec![0xff,0xfe],text.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat());
    f.write("be.txt",[vec![0xfe,0xff],text.encode_utf16().flat_map(u16::to_be_bytes).collect()].concat());
    let s=f.build(Engine::Tantivy);let hits=f.search(&needle).0;assert_eq!(hits.len(),3);
    for name in ["utf8.txt","le.txt","be.txt"] {
        let note=f.note(s.generation,name);let mut got=String::new();let mut cursor:Option<String>=None;
        loop{let view=if let Some(c)=cursor.take(){read_cursor_conn(&f.conn,&f.lib,&c,Some(37)).unwrap()}else{read_chunk_conn(&f.conn,&f.lib,&note,None,0,Some(37)).unwrap().unwrap()};assert_eq!(view.end_byte-view.start_byte,view.content.len());got.push_str(&view.content);cursor=view.next_cursor;if cursor.is_none(){break;}}
        assert_eq!(got,text);let hit=hits.iter().find(|h|h.relative_uri==name).unwrap();let r=hit_reference_for_query(&f.conn,&f.lib,s.generation,hit,&kb_index::parse_query(&needle).unwrap()).unwrap();assert!(r.match_end.unwrap()>r.primary_end_byte);
        let (v,proof,_)=verified::read(&f.conn,Some("p"),&f.lib,Some(&note),None,Some(37)).unwrap();assert_eq!(v.source_hash,format!("sha256:{:x}",Sha256::digest(fs::read(f.root.join(name)).unwrap())));drop(proof);
    }
}
#[test]
fn formal_verified_read_search_many_revoke_disable_external_delete_and_continuation(){
    let f=Fixture::new();let text=("中 Ω\t\u{1}正文\r\n".repeat(80))+"needle";f.write("a.txt",&text);let s=f.build(Engine::Tantivy);let note=f.note(s.generation,"a.txt");
    let out=verified::search(&f.conn,Some("p"),"needle").unwrap();assert_eq!(out["hits"][0]["sourceVerified"],true);let hitref=out["hits"][0]["hitRef"].as_str().unwrap();
    assert!(verified::read(&f.conn,Some("p"),&f.lib,None,Some(hitref),Some(37)).is_ok());
    let mut got=String::new();let mut cursor:Option<String>=None;
    loop {let(v,proof,_)=verified::read(&f.conn,Some("p"),&f.lib,Some(&note),cursor.as_deref(),Some(37)).unwrap();assert!(serde_json::to_vec(&v).unwrap().len()<=8192);got.push_str(&v.content);cursor=v.next_cursor;drop(proof);if cursor.is_none(){break;}}
    assert_eq!(got,text);
    let items=[serde_json::json!({"libraryId":f.lib,"noteId":note})];assert_eq!(verified::read_many(&f.conn,Some("p"),&items).unwrap()["notes"].as_array().unwrap().len(),1);
    f.conn.execute("UPDATE project_library_grant SET readAllowed=0,revision=revision+1 WHERE libraryId=?1",[&f.lib]).unwrap();assert!(verified::read(&f.conn,Some("p"),&f.lib,None,Some(hitref),None).is_err());assert_eq!(verified::search(&f.conn,Some("p"),"needle").unwrap()["denied"],true);assert!(verified::read_many(&f.conn,Some("p"),&items).unwrap()["notes"].as_array().unwrap().is_empty());
    f.conn.execute("UPDATE project_library_grant SET readAllowed=1,revision=revision+1 WHERE libraryId=?1",[&f.lib]).unwrap();f.conn.execute("UPDATE knowledge_library SET enabled=0 WHERE id=?1",[&f.lib]).unwrap();assert!(verified::read(&f.conn,Some("p"),&f.lib,Some(&note),None,None).is_err());
    f.conn.execute("UPDATE knowledge_library SET enabled=1 WHERE id=?1",[&f.lib]).unwrap();f.write("a.txt","external needle");assert!(verified::search(&f.conn,Some("p"),"needle").unwrap_err().contains("SOURCE_CHANGED"));assert!(verified::read(&f.conn,Some("p"),&f.lib,Some(&note),None,None).is_err());
    fs::remove_file(f.root.join("a.txt")).unwrap();assert!(verified::read(&f.conn,Some("p"),&f.lib,Some(&note),None,None).is_err());
}
#[test]
fn formal_persistent_cancel_cas_restart_and_quota_keep_old(){
    let f=Fixture::new();f.write("a.txt","original needle");let old=f.build(Engine::Sqlite);
    for cause in ["cancel","fence","disable","root","quota"] {
        let s=f.spec(Engine::Tantivy);let mut limits=Fixture::limits();
        match cause{"cancel"=>{f.conn.execute("UPDATE kb_snap_job SET cancelRequested=1 WHERE id=?1",[&s.id]).unwrap();},"fence"=>{invalidate_source_tx(&f.conn,&f.lib).unwrap();},"disable"=>{f.conn.execute("UPDATE knowledge_library SET enabled=0 WHERE id=?1",[&f.lib]).unwrap();},"root"=>{f.conn.execute("UPDATE knowledge_library SET sourceRef='missing-root' WHERE id=?1",[&f.lib]).unwrap();},_=>limits.logical_bytes=1}
        let e=build_snapshot(&f.conn,&s,&AtomicBool::new(false),&limits).unwrap_err();terminal(&f.conn,&s,"failed",&e).unwrap();assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
        f.conn.execute("UPDATE knowledge_library SET enabled=1,sourceRef=?2 WHERE id=?1",params![f.lib,f.root.to_string_lossy()]).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    }
    let pending=f.spec(Engine::Tantivy);recover_interrupted(&f.conn).unwrap();assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&pending.id).unwrap().phase,"interrupted");gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    let s=f.build(Engine::Tantivy);assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,s.generation);
    f.conn.execute("UPDATE kb_snap_job SET cancelRequested=1 WHERE id=?1 AND phase<>'completed'",[&s.id]).unwrap();assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&s.id).unwrap().phase,"completed");
    assert_eq!(fs::read_to_string(f.root.join("a.txt")).unwrap(),"original needle");
}
#[test]
fn formal_missing_sidecar_unknown_schema_sql_member_tamper_and_physical_quota(){
    let f=Fixture::new();f.write("a.txt","needle");let s=f.build(Engine::Tantivy);let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    f.conn.execute("UPDATE kb_snap_generation SET engineSchemaVersion=99 WHERE id=?1",[s.generation]).unwrap();assert!(f.search_error("needle").contains("REBUILD"));f.conn.execute("UPDATE kb_snap_generation SET engineSchemaVersion=?2 WHERE id=?1",params![s.generation,tantivy_engine::SCHEMA_VERSION]).unwrap();
    f.conn.execute("UPDATE kb_snap_member SET sourceHash='sha256:bad' WHERE generation=?1",[s.generation]).unwrap();assert!(f.search_error("needle").contains("METADATA_MISMATCH"));
    let mut limits=Fixture::limits();limits.disk_bytes=1;assert!(check_disk(&f.conn,&limits).unwrap_err().contains("DISK_QUOTA"));
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();fs::rename(path.join("sealed.json"),path.join("sealed-away.json")).unwrap();assert!(f.search_error("needle").contains("INDEX_MISSING"));
}
impl Fixture {fn search_error(&self,q:&str)->String{search_library(&self.conn,&self.lib,&kb_index::parse_query(q).unwrap()).unwrap_err()}}
#[test]
fn formal_project_scope_and_crlf_budget_line_proofs(){
    let f=Fixture::new();let text=format!("{}\r\n中{}\r\n尾部", "x".repeat(36),"a".repeat(CHUNK_BYTES));f.write("a.txt",&text);let s=f.build(Engine::Tantivy);let note=f.note(s.generation,"a.txt");
    f.conn.execute("INSERT INTO project_library_grant VALUES('other',?1,1,1)",[&f.lib]).unwrap();
    let first=kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),&f.lib,&note,Some(37)).unwrap();let token=first.next_cursor.unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("other"),&f.lib,&token,None).unwrap_err().contains("SCOPE_MISMATCH"));
    assert!(verified::read(&f.conn,Some("other"),&f.lib,None,Some(&token),None).is_err());
    let mut cursor=None;let(mut got,mut line,mut cr)=(String::new(),1,false);
    loop{let(v,proof,_)=verified::read(&f.conn,Some("p"),&f.lib,Some(&note),cursor.as_deref(),Some(37)).unwrap();assert_eq!(v.start_line,line);let(next,next_cr)=advance_lines(&v.content,line,cr);assert_eq!(v.end_line,next);line=next;cr=next_cr;got.push_str(&v.content);cursor=v.next_cursor;drop(proof);if cursor.is_none(){break;}}
    assert_eq!(got,text);assert_eq!(line,3);
}
#[test]
fn formal_after_seal_cancel_fence_root_disable_and_retry_keep_active(){
    let f=Fixture::new();f.write("a.txt","stable needle");let old=f.build(Engine::Sqlite);
    for cause in ["cancel","fence","root","disable"]{
        let spec=f.spec(Engine::Tantivy);
        BEFORE_PUBLISH.with(|hook|*hook.borrow_mut()=Some(Box::new(move|conn,spec|{
            assert!(tantivy_engine::location(conn,&spec.library,spec.generation).unwrap().join("sealed.json").is_file());
            match cause{"cancel"=>{conn.execute("UPDATE kb_snap_job SET cancelRequested=1 WHERE id=?1",[&spec.id]).unwrap();},"fence"=>{invalidate_source_tx(conn,&spec.library).unwrap();},"root"=>{conn.execute("UPDATE knowledge_library SET sourceRef='changed' WHERE id=?1",[&spec.library]).unwrap();},_=>{conn.execute("UPDATE knowledge_library SET enabled=0 WHERE id=?1",[&spec.library]).unwrap();}}
        })));
        let e=build_snapshot(&f.conn,&spec,&AtomicBool::new(false),&Fixture::limits()).unwrap_err();terminal(&f.conn,&spec,if e=="CANCELLED"{"cancelled"}else{"failed"},&e).unwrap();
        assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
        assert!(["cancelled","failed"].contains(&task_row(&f.conn,"formal-owner",&f.lib,&spec.id).unwrap().phase.as_str()));
        f.conn.execute("UPDATE knowledge_library SET enabled=1,sourceRef=?2 WHERE id=?1",params![f.lib,f.root.to_string_lossy()]).unwrap();
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    }
    let retry=f.build(Engine::Tantivy);assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&retry.id).unwrap().phase,"completed");
}
#[test]
fn formal_lease_limits_ttl_gc_and_own_close_isolation(){
    let f=Fixture::new();f.write("a.txt","needle");let old=f.build(Engine::Tantivy);let mut tokens=Vec::new();
    for owner in ["scope-a","scope-b"]{for _ in 0..32{tokens.push((owner,acquire_lease(&f.conn,owner,&f.lib,old.generation).unwrap()));}assert!(acquire_lease(&f.conn,owner,&f.lib,old.generation).unwrap_err().contains("QUOTA"));}
    assert!(acquire_lease(&f.conn,"scope-c",&f.lib,old.generation).is_err());
    assert!(release_lease("wrong",&tokens[0].1).is_err());
    for(owner,token)in tokens{release_lease(owner,&token).unwrap();}
    let a=acquire_lease(&f.conn,"scope-a",&f.lib,old.generation).unwrap();let b=acquire_lease(&f.conn,"scope-b",&f.lib,old.generation).unwrap();
    {let mut rt=lock_runtime().unwrap();rt.owners.insert("test-a-window".into(),"scope-a".into());rt.owners.insert("test-b-window".into(),"scope-b".into());}
    close_window("test-a-window");{let rt=lock_runtime().unwrap();assert!(!rt.leases.contains_key(&a));assert!(rt.leases.contains_key(&b));}
    let current=f.build(Engine::Tantivy);assert!(!gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap());
    {lock_runtime().unwrap().leases.get_mut(&b).unwrap().touched=Instant::now()-LEASE_TTL-Duration::from_secs(1);}
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap().exists());assert!(tantivy_engine::location(&f.conn,&f.lib,current.generation).unwrap().exists());close_window("test-b-window");
}
#[test]
fn formal_physical_probe_tolerates_concurrent_managed_temp_deletion(){
    let f=Fixture::new();let path=f.work.join("quota-probe");fs::create_dir(&path).unwrap();fs::write(path.join("stable"),[0u8;17]).unwrap();let worker_path=path.clone();
    let worker=std::thread::spawn(move||{
        for i in 0..1500{
            let p=worker_path.join(format!("temp-{i}"));
            fs::create_dir(&p).unwrap();fs::write(p.join("merging"),[0u8;64]).unwrap();
            // Windows delete-pending: 与主线程探测并发时目录可能已消失，属预期竞态
            match fs::remove_dir_all(&p){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>panic!("remove_dir_all: {e}")}
        }
    });
    for _ in 0..1500{
        // 允许瞬时 delete-pending 探测失败，但重试后必须成功（验证产品探测最终可用）
        let mut last=String::new();let mut ok=false;
        for _ in 0..8{
            match directory_bytes(&path){
                Ok(_)=>{ok=true;break;},
                Err(e)if e.starts_with("INDEX_DISK_PROBE")=>{last=e;std::thread::sleep(std::time::Duration::from_millis(2));},
                Err(e)=>panic!("unexpected probe error: {e}")
            }
        }
        assert!(ok,"并发删除期间磁盘探测持续失败: {last}");
    }
    worker.join().unwrap();assert_eq!(directory_bytes(&path).unwrap(),17);
}
#[test]
fn formal_commit_monitor_quota_and_reservation_release_on_unwind(){
    let f=Fixture::new();f.write("a.txt","needle");let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);
    let writer=tantivy_engine::Writer::create(&f.conn,&spec).unwrap();let mut limits=Fixture::limits();limits.disk_bytes=1;
    let result=writer.commit_monitored(&f.conn,&spec,&AtomicBool::new(false),&limits);assert!(result.err().unwrap().contains("DISK_QUOTA"));
    assert!(tantivy_engine::location(&f.conn,&f.lib,spec.generation).unwrap().join("meta.json").exists());assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
    terminal(&f.conn,&spec,"failed","quota").unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    let cancel=Arc::new(AtomicBool::new(false));{lock_runtime().unwrap().build=Some(ActiveBuild{owner:"reservation-test".into(),library:f.lib.clone(),id:"reservation-test".into(),cancel:cancel.clone()});}
    let panic=std::panic::catch_unwind(move||{let _guard=BuildReservation{cancel};panic!("injected worker unwind");});assert!(panic.is_err());assert!(lock_runtime().unwrap().build.is_none());
    let retry=f.spec(Engine::Tantivy);let result=build_snapshot(&f.conn,&retry,&AtomicBool::new(false),&Fixture::limits());assert!(result.is_ok(),"retry={result:?}, task={:?}, work={:?}, sourceExists={}",task_row(&f.conn,"formal-owner",&f.lib,&retry.id),f.work,f.root.is_dir());assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&retry.id).unwrap().phase,"completed");
}
#[test]
fn formal_cached_file_tamper_and_unknown_member_versions_fail_closed(){
    let f=Fixture::new();f.write("a.txt","needle");let s=f.build(Engine::Tantivy);assert!(!f.search("needle").0.is_empty());
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let meta=path.join("meta.json");let mut bytes=fs::read(&meta).unwrap();bytes[0]=b'X';
    #[cfg(windows)] {assert!(fs::write(&meta,&bytes).is_err(),"cached sealed files must reject writes");assert!(!f.search("needle").0.is_empty());}
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();fs::write(&meta,bytes).unwrap();assert!(f.search_error("needle").contains("FILE_HASH_MISMATCH"));
    let g=Fixture::new();g.write("a.txt","needle");let old=g.build(Engine::Sqlite);let note=g.note(old.generation,"a.txt");let key=g.search("needle").0[0].chunk_key;
    for (field,value) in [("parserVersion",PARSER_VERSION),("chunkerVersion",CHUNKER_VERSION),("encodingVersion",ENCODING_VERSION),("optionsHash",options_hash().as_str())]{
        g.conn.execute(&format!("UPDATE kb_snap_member SET {field}='unknown' WHERE generation=?1"),[old.generation]).unwrap();
        assert!(read_chunk_conn(&g.conn,&g.lib,&note,None,0,None).unwrap_err().contains("REBUILD"));
        for query in ["needle","definitelyabsent","中",""] {assert!(g.search_error(query).contains("REBUILD"),"{field}: {query}");}
        assert!(hit_reference(&g.conn,&g.lib,old.generation,key).unwrap_err().contains("REBUILD"));
        g.conn.execute(&format!("UPDATE kb_snap_member SET {field}=?2 WHERE generation=?1"),params![old.generation,value]).unwrap();
    }
    g.conn.execute("UPDATE kb_snap_member SET contextVersion='unknown' WHERE generation=?1",[old.generation]).unwrap();
    assert!(g.search_error("definitelyabsent").contains("CONTEXT_UNSUPPORTED"));
    assert!(hit_reference(&g.conn,&g.lib,old.generation,key).unwrap_err().contains("CONTEXT_UNSUPPORTED"));
}
#[test]
fn formal_unknown_tokenizer_rejects_all_reads_and_rebuild_gc_recovers(){
    let f=Fixture::new();f.write("a.txt","needle body\r\n".repeat(300));let old=f.build(Engine::Sqlite);let note=f.note(old.generation,"a.txt");let hit=f.search("needle").0.remove(0);
    let first=read_chunk_conn(&f.conn,&f.lib,&note,None,0,Some(37)).unwrap().unwrap();let cursor=first.next_cursor.unwrap();
    f.conn.execute("UPDATE kb_snap_generation SET tokenizerVersion='unknown' WHERE id=?1",[old.generation]).unwrap();
    assert!(read_chunk_conn(&f.conn,&f.lib,&note,Some(old.generation),0,None).unwrap_err().contains("REBUILD"));
    assert!(read_hit_conn(&f.conn,&f.lib,old.generation,hit.chunk_key,None).unwrap_err().contains("REBUILD"));
    assert!(read_cursor_conn(&f.conn,&f.lib,&cursor,Some(37)).unwrap_err().contains("REBUILD"));
    assert!(hit_reference(&f.conn,&f.lib,old.generation,hit.chunk_key).unwrap_err().contains("REBUILD"));
    for query in ["needle","definitelyabsent","中",""]{assert!(f.search_error(query).contains("REBUILD"));}
    let rebuilt=f.build(Engine::Sqlite);assert_ne!(first.parse_generation,read_chunk_conn(&f.conn,&f.lib,&note,None,0,None).unwrap().unwrap().parse_generation);
    assert_eq!(f.search("needle").0[0].snapshot_generation,Some(rebuilt.generation));
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"collected");
    assert_eq!(fs::read_to_string(f.root.join("a.txt")).unwrap(),"needle body\r\n".repeat(300));
}
#[test]
fn formal_tantivy_zero_candidate_unknown_member_versions_fail_closed(){
    let f=Fixture::new();f.write("a.txt","needle");let s=f.build(Engine::Tantivy);let note=f.note(s.generation,"a.txt");let key=f.search("needle").0[0].chunk_key;
    for (field,value) in [("parserVersion",PARSER_VERSION),("chunkerVersion",CHUNKER_VERSION),("encodingVersion",ENCODING_VERSION),("optionsHash",options_hash().as_str())]{
        f.conn.execute(&format!("UPDATE kb_snap_member SET {field}='unknown' WHERE generation=?1"),[s.generation]).unwrap();
        for query in ["definitelyabsent", "", "中", "needle"]{assert!(f.search_error(query).contains("REBUILD"),"{field}: {query}");}
        assert!(read_chunk_conn(&f.conn,&f.lib,&note,None,0,None).is_err());assert!(hit_reference(&f.conn,&f.lib,s.generation,key).is_err());
        f.conn.execute(&format!("UPDATE kb_snap_member SET {field}=?2 WHERE generation=?1"),params![s.generation,value]).unwrap();
    }
    f.conn.execute("UPDATE kb_snap_member SET contextVersion='unknown' WHERE generation=?1",[s.generation]).unwrap();
    for query in ["definitelyabsent","","中","needle"]{assert!(f.search_error(query).contains("CONTEXT_UNSUPPORTED"));}
    assert!(hit_reference(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("CONTEXT_UNSUPPORTED"));
}
#[test]
fn formal_candidate_overflow_and_dense_other_library_statistics_isolated(){
    let f=Fixture::new();for i in 0..110 {f.write(&format!("{i:03}.txt"),"common identical body");}f.write("title-common.txt","unrelated");let s=f.build(Engine::Tantivy);let before=f.search("common");assert!(before.1);assert_eq!(before.0[0].relative_uri,"title-common.txt");
    let mut other=Fixture::new();other.conn=Connection::open(f.work.join("test.db")).unwrap();other.conn.execute("INSERT INTO knowledge_library(id,name,sourceRef) VALUES(?1,'dense',?2)",params![other.lib,other.root.to_string_lossy()]).unwrap();other.conn.execute("INSERT INTO project_library_grant VALUES('p',?1,1,1)",[&other.lib]).unwrap();for i in 0..70{other.write(&format!("{i}.txt"),"common common common common");}other.build(Engine::Tantivy);let after=f.search("common");assert_eq!(before.0.iter().map(|h|(&h.relative_uri,h.score)).collect::<Vec<_>>(),after.0.iter().map(|h|(&h.relative_uri,h.score)).collect::<Vec<_>>());assert_eq!(after.0[0].snapshot_generation,Some(s.generation));
}

#[test]
fn repairs_v2_r1_self_consistent_derived_forgery_cannot_prove_source(){
    use tantivy::{Index,schema::TantivyDocument};
    let f=Fixture::new();f.write("a.txt","needle");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    let (mut meta,_,suffix)=tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap();
    let index=Index::open_in_dir(&path).unwrap();let schema=index.schema();drop(index);tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();
    let source_sha=Sha256::digest(fs::read(f.root.join("a.txt")).unwrap());
    // A genuine new store with forged primary and matching store-internal primarySHA.
    let forged=f.work.join("forged");fs::create_dir(&forged).unwrap();
    meta.primary_sha=format!("sha256:{:x}",Sha256::digest(b"forged"));
    let idx=Index::create_in_dir(&forged,schema.clone()).unwrap();idx.tokenizers().register("host_whitespace",tantivy::tokenizer::WhitespaceTokenizer::default());
    let mut writer=idx.writer_with_num_threads(1,tantivy_engine::WRITER_BYTES).unwrap();let mut doc=TantivyDocument::default();
    doc.add_u64(schema.get_field("chunk_key").unwrap(),key as u64);doc.add_text(schema.get_field("primary").unwrap(),"forged");doc.add_text(schema.get_field("suffix").unwrap(),&suffix);doc.add_text(schema.get_field("metadata").unwrap(),serde_json::to_string(&meta).unwrap());doc.add_text(schema.get_field("body_terms").unwrap(),"forged");
    doc.add_text(schema.get_field("stable_note").unwrap(),&meta.note);doc.add_u64(schema.get_field("stable_ordinal").unwrap(),meta.ordinal as u64);
    writer.add_document(doc).unwrap();writer.commit().unwrap();writer.wait_merging_threads().unwrap();drop(idx);
    let mut seal:serde_json::Value=serde_json::from_slice(&fs::read(path.join("sealed.json")).unwrap()).unwrap();
    for entry in fs::read_dir(&path).unwrap(){let p=entry.unwrap().path();if !["ownership.json","sealed.json"].contains(&p.file_name().unwrap().to_str().unwrap()){fs::remove_file(p).unwrap();}}
    for entry in fs::read_dir(&forged).unwrap(){let p=entry.unwrap().path();fs::copy(&p,path.join(p.file_name().unwrap())).unwrap();}
    let mut files=Vec::new();for entry in fs::read_dir(&path).unwrap(){let p=entry.unwrap().path();let name=p.file_name().unwrap().to_str().unwrap();if name=="sealed.json"||name.contains("lock"){continue;}let bytes=fs::read(&p).unwrap();files.push(serde_json::json!({"name":name,"bytes":bytes.len(),"sha256":format!("sha256:{:x}",Sha256::digest(&bytes))}));}
    seal["files"]=serde_json::json!(files);fs::write(path.join("sealed.json"),serde_json::to_vec(&seal).unwrap()).unwrap();
    // Simulate a fresh process. No old cache fingerprint may provide the rejection.
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();
    let result=read_hit_conn(&f.conn,&f.lib,s.generation,key,None);
    assert!(result.is_err(),"self-consistent derived forgery was accepted: {result:?}");
    assert_eq!(Sha256::digest(fs::read(f.root.join("a.txt")).unwrap()),source_sha);
    assert_eq!(f.conn.query_row("SELECT sourceHash FROM kb_snap_member WHERE generation=?1",[s.generation],|r|r.get::<_,String>(0)).unwrap(),format!("sha256:{source_sha:x}"));
}
#[test]
fn repairs_v2_r7_regrant_does_not_resurrect_ai_cursor(){
    let f=Fixture::new();f.write("a.txt","needle body\r\n".repeat(700));let s=f.build(Engine::Tantivy);let note=f.note(s.generation,"a.txt");
    let first=kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),&f.lib,&note,Some(37)).unwrap();let cursor=first.next_cursor.unwrap();
    f.conn.execute("UPDATE project_library_grant SET readAllowed=0,revision=revision+1 WHERE libraryId=?1",[&f.lib]).unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&cursor,None).is_err());
    f.conn.execute("UPDATE project_library_grant SET readAllowed=1,revision=revision+1 WHERE libraryId=?1",[&f.lib]).unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&cursor,None).is_err(),"regrant resurrected an old capability");
    assert!(verified::read(&f.conn,Some("p"),&f.lib,None,Some(&cursor),None).is_err());
    let new=kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),&f.lib,&note,Some(37)).unwrap().next_cursor.unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&new,None).is_ok());
    f.conn.execute("UPDATE project_library_grant SET revision=revision+1 WHERE libraryId=?1",[&f.lib]).unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&new,None).is_err());
}
#[test]
fn repairs_v2_r2_metadata_revoke_during_second_library_hash_rejects_envelope(){
    let f=Fixture::new();f.write("needle.pdf",b"metadata original");f.build(Engine::Tantivy);
    let mut body=Fixture::new();body.conn=Connection::open(f.work.join("test.db")).unwrap();body.lib="zz-body-library".into();
    body.conn.execute("INSERT INTO knowledge_library(id,name,sourceRef) VALUES(?1,'body',?2)",params![body.lib,body.root.to_string_lossy()]).unwrap();body.conn.execute("INSERT INTO project_library_grant VALUES('p',?1,1,1)",[&body.lib]).unwrap();body.write("needle.txt","needle body");body.build(Engine::Tantivy);
    let before=verified::search(&f.conn,Some("p"),"needle").unwrap();assert_eq!(before["hits"][0]["libraryId"],f.lib);assert_eq!(before["hits"][0]["contentUnavailable"],true);
    let database=f.work.join("test.db");let revoke=f.lib.clone();let body_library=body.lib.clone();
    verified::DURING_HASH.with(|h|*h.borrow_mut()=Some(Box::new(move|reference|{
        assert_eq!(reference.library_id,body_library);
        Connection::open(database).unwrap().execute("UPDATE project_library_grant SET readAllowed=0,revision=revision+1 WHERE libraryId=?1",[revoke]).unwrap();
    })));
    let out=verified::search(&f.conn,Some("p"),"needle");
    assert!(out.is_err(),"revoked retained metadata leaked in final envelope: {out:?}");
    assert!(verified::DURING_HASH.with(|h|h.borrow().is_none()));
}

#[test]
fn repairs_v2_r1_null_anchor_migration_and_incomplete_seal_fail_closed(){
    let f=Fixture::new();f.write("a.txt","needle body");let old=f.build(Engine::Sqlite);
    for name in ["engineKind","engineSchemaVersion","enginePath","engineFormat","engineOptionsHash","engineSealHash"]{f.conn.execute_batch(&format!("ALTER TABLE kb_snap_generation DROP COLUMN {name}")).unwrap();}
    migrate(&f.conn).unwrap();migrate(&f.conn).unwrap();assert!(!f.search("needle").0.is_empty());
    assert_eq!(f.conn.query_row("SELECT engineSealHash FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,Option<String>>(0)).unwrap(),None);
    let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    let bytes=fs::read(path.join("sealed.json")).unwrap();let trusted=format!("sha256:{:x}",Sha256::digest(&bytes));
    assert_eq!(f.conn.query_row("SELECT engineSealHash FROM kb_snap_generation WHERE id=?1",[s.generation],|r|r.get::<_,String>(0)).unwrap(),trusted);
    f.conn.execute("UPDATE kb_snap_generation SET engineSealHash=NULL WHERE id=?1",[s.generation]).unwrap();
    assert!(read_hit_conn(&f.conn,&f.lib,s.generation,key,None).unwrap_err().contains("REBUILD_REQUIRED"));
    f.conn.execute("UPDATE kb_snap_generation SET engineSealHash=?2 WHERE id=?1",params![s.generation,trusted]).unwrap();
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();let mut seal:serde_json::Value=serde_json::from_slice(&bytes).unwrap();seal["files"].as_array_mut().unwrap().retain(|e|e["name"]!="meta.json");let incomplete=serde_json::to_vec(&seal).unwrap();fs::write(path.join("sealed.json"),&incomplete).unwrap();
    // Simulate a defective publishing implementation signing an incomplete file manifest.
    f.conn.execute("UPDATE kb_snap_generation SET engineSealHash=?2 WHERE id=?1",params![s.generation,format!("sha256:{:x}",Sha256::digest(&incomplete))]).unwrap();tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();
    assert!(read_hit_conn(&f.conn,&f.lib,s.generation,key,None).unwrap_err().contains("SEAL_INCOMPLETE"));
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle body");
}
#[test]
fn repairs_v2_r2_metadata_disable_root_and_epoch_changes_during_hash_reject(){
    for action in ["disable","root","epoch","revision"]{
        let f=Fixture::new();f.write("needle.pdf",b"metadata original");f.build(Engine::Tantivy);
        let mut body=Fixture::new();body.conn=Connection::open(f.work.join("test.db")).unwrap();body.lib="zz-body-library".into();body.conn.execute("INSERT INTO knowledge_library(id,name,sourceRef) VALUES(?1,'body',?2)",params![body.lib,body.root.to_string_lossy()]).unwrap();body.conn.execute("INSERT INTO project_library_grant VALUES('p',?1,1,1)",[&body.lib]).unwrap();body.write("needle.txt","needle body");body.build(Engine::Tantivy);
        let before=verified::search(&f.conn,Some("p"),"needle").unwrap();assert_eq!(before["hits"][0]["libraryId"],f.lib);assert_eq!(before["hits"][0]["contentUnavailable"],true);
        let db=f.work.join("test.db");let lib=f.lib.clone();let newroot=body.root.to_string_lossy().into_owned();let expected_body=body.lib.clone();
        verified::DURING_HASH.with(|h|*h.borrow_mut()=Some(Box::new(move|reference|{
            assert_eq!(reference.library_id,expected_body);let conn=Connection::open(db).unwrap();match action{
                "disable"=>{conn.execute("UPDATE knowledge_library SET enabled=0 WHERE id=?1",[lib]).unwrap();},
                "root"=>{conn.execute("UPDATE knowledge_library SET sourceRef=?2 WHERE id=?1",params![lib,newroot]).unwrap();},
                "epoch"=>{conn.execute("UPDATE kb_snap_control SET epoch=epoch+1 WHERE libraryId=?1",[lib]).unwrap();},
                _=>{conn.execute("UPDATE project_library_grant SET revision=revision+1 WHERE libraryId=?1",[lib]).unwrap();}
            }
        })));
        assert!(verified::search(&f.conn,Some("p"),"needle").is_err(),"retained metadata not fenced: {action}");assert!(verified::DURING_HASH.with(|h|h.borrow().is_none()));
    }
}
#[test]
fn repairs_v2_r7_scope_ttl_and_unbound_human_cursor_remain_separate(){
    let f=Fixture::new();f.write("a.txt","needle body\r\n".repeat(700));let s=f.build(Engine::Tantivy);let note=f.note(s.generation,"a.txt");
    f.conn.execute("INSERT INTO project_library_grant VALUES('p2',?1,1,1)",[&f.lib]).unwrap();
    let ai=kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),&f.lib,&note,Some(37)).unwrap().next_cursor.unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p2"),&f.lib,&ai,None).is_err());
    let human=read_chunk_conn(&f.conn,&f.lib,&note,Some(s.generation),0,Some(37)).unwrap().unwrap().next_cursor.unwrap();
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&human,None).is_err());assert!(read_cursor_conn(&f.conn,&f.lib,&human,Some(37)).is_ok());
    lock_runtime().unwrap().cursors.get_mut(&ai).unwrap().1=Instant::now()-LEASE_TTL-Duration::from_secs(1);
    assert!(kb_index::gateway_read_cursor_conn(&f.conn,Some("p"),&f.lib,&ai,None).unwrap_err().contains("CURSOR_EXPIRED"));
}
#[test]
#[cfg(windows)]
fn repairs_v2_r3_live_reader_pins_generation_and_parent_until_forget(){
    let f=Fixture::new();f.write("a.txt","needle original");let s=f.build(Engine::Tantivy);assert!(!f.search("needle").0.is_empty());
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let away=path.with_extension("moved");
    let p=path.clone();let a=away.clone();let result=std::thread::spawn(move||fs::rename(p,a)).join().unwrap();
    if result.is_ok(){fs::rename(&away,&path).unwrap();}
    assert!(result.is_err(),"live reader did not pin the generation entity");
    let meta=path.join("meta.json");let original=fs::read(&meta).unwrap();assert!(fs::write(&meta,&original).is_err(),"live reader left sealed metadata writable");
    let parent=path.parent().unwrap();assert!(fs::rename(parent,parent.with_extension("moved")).is_err());
    let attempted=std::process::Command::new("cmd.exe").args(["/D","/C","mklink","/J"]).arg(&path).arg(&f.root).output().unwrap();assert!(!attempted.status.success(),"live generation must not become a junction");
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();fs::rename(&path,&away).unwrap();
    let created=std::process::Command::new("cmd.exe").args(["/D","/C","mklink","/J"]).arg(&path).arg(&f.root).output().unwrap();assert!(created.status.success(),"isolated junction fixture failed: {:?}",created);
    assert!(f.search_error("needle").contains("UNSAFE"));let m=fs::symlink_metadata(&path).unwrap();assert!(unsafe_entry(&m));fs::remove_dir(&path).unwrap();fs::rename(&away,&path).unwrap();assert!(!f.search("needle").0.is_empty());
    println!("Windows junction swap: live blocked, closed-reader replacement explicitly rejected");
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle original");
}
#[test]
#[cfg(windows)]
fn repairs_v2_r3_gc_rejects_replacement_entity_and_preserves_originals(){
    let f=Fixture::new();f.write("a.txt","needle original");let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);
    let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let away=path.with_extension("original-entity");tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();fs::rename(&path,&away).unwrap();fs::create_dir(&path).unwrap();fs::write(path.join("keep"),b"replacement").unwrap();
    assert!(gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap_err().contains("ENTITY_CHANGED"));assert_eq!(fs::read(path.join("keep")).unwrap(),b"replacement");assert!(away.join("ownership.json").is_file());assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));
    fs::remove_file(path.join("keep")).unwrap();fs::remove_dir(&path).unwrap();fs::rename(&away,&path).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!path.exists());assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle original");
}
// Before-fix fixture shim: only the test DB gains the proposed journal column.
// This lets the unchanged v2 production migration/remove expose the recovery bug.
#[cfg(windows)]
fn r4_v3_fixture_stage(conn:&Connection){
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('kb_snap_managed_entity') WHERE name='cleanupStage')",[],|r|r.get(0)).unwrap();
    if !exists{conn.execute_batch("ALTER TABLE kb_snap_managed_entity ADD COLUMN cleanupStage TEXT NOT NULL DEFAULT 'pending'").unwrap();}
}
#[cfg(windows)]
fn r4_v3_restart(f:&mut Fixture,generations:&[i64]){
    for g in generations{tantivy_engine::forget(&f.conn,&f.lib,*g).unwrap();}
    let old=std::mem::replace(&mut f.conn,Connection::open_in_memory().unwrap());drop(old);
    f.conn=Connection::open(f.work.join("test.db")).unwrap();
    f.conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;").unwrap();migrate(&f.conn).unwrap();recover_interrupted(&f.conn).unwrap();
}
#[cfg(windows)]
fn r4_v3_journal(f:&Fixture,g:i64)->(String,Option<String>,String,i64){
    f.conn.query_row("SELECT entityId,cleanupPath,cleanupStage,deleteComplete FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![f.lib,g],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}
#[cfg(windows)]
fn r4_v3_source_sha(f:&Fixture)->String{format!("{:x}",Sha256::digest(fs::read(f.root.join("a.txt")).unwrap()))}
#[cfg(windows)]
fn r4_v3_files_sha(path:&std::path::Path)->std::collections::BTreeMap<String,String>{
    fs::read_dir(path).unwrap().map(|entry|{let entry=entry.unwrap();assert!(entry.file_type().unwrap().is_file());(entry.file_name().into_string().unwrap(),format!("{:x}",Sha256::digest(fs::read(entry.path()).unwrap())))}).collect()
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_deleted_then_sql_mark_failure_restarts_without_opening_replacement(){
    let mut f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);
    let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);r4_v3_fixture_stage(&f.conn);
    tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();
    let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let entity=r4_v3_journal(&f,old.generation).0;
    let tombstone=path.with_file_name(format!("{}.gc-mark-failure",old.generation));
    f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,tombstone.to_string_lossy()]).unwrap();
    let mut delete=files::SnapshotDelete::open(&path,&entity).unwrap();delete.rename(&tombstone).unwrap();
    f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupStage='renameConfirmed' WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation]).unwrap();drop(delete);
    fs::create_dir(&path).unwrap();fs::write(path.join("keep"),b"replacement must survive").unwrap();
    let replacement=files::SnapshotPins::new(&path).unwrap().entity().unwrap();assert_ne!(replacement,entity);
    f.conn.execute_batch("CREATE TEMP TRIGGER reject_deleted_mark BEFORE UPDATE OF deleteComplete ON kb_snap_managed_entity WHEN NEW.deleteComplete=1 BEGIN SELECT RAISE(ABORT,'r4_deleted_mark_injected'); END;").unwrap();
    let error=gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap_err();assert!(error.contains("r4_deleted_mark_injected"),"real SQL mark trigger must fire: {error}");
    assert!(!tombstone.exists(),"physical children+directory deletion must finish before failing mark");
    let journal=r4_v3_journal(&f,old.generation);assert_eq!(journal.0,entity);assert_eq!(journal.2,"renameConfirmed");assert_eq!(journal.3,0);
    assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"collecting");
    assert!(begin_build_engine(&f.conn,"formal-owner",&f.lib,&new_id("req"),Engine::Tantivy).err().expect("limit2 must reject another build").contains("BUSY_RETRY"));
    assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,current.generation);
    println!("R4 mark trigger fired; real tombstone deletion finished; persisted confirmed/deleteComplete0; limit2 BUSY; restarting connection");
    r4_v3_restart(&mut f,&[old.generation,current.generation]);assert_eq!(r4_v3_journal(&f,old.generation).2,"renameConfirmed");
    // Hold a deny-DELETE pin on the different entity: successful recovery cannot adopt it.
    let replacement_pin=files::SnapshotPins::new(&path).unwrap();assert_eq!(replacement_pin.entity().unwrap(),replacement);
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).expect("confirmed missing tombstone must finish SQL without opening original replacement");
    assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"collected");
    let registered:i64=f.conn.query_row("SELECT COUNT(*) FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation],|r|r.get(0)).unwrap();assert_eq!(registered,0);
    assert_eq!(fs::read(path.join("keep")).unwrap(),b"replacement must survive");replacement_pin.verify().unwrap();
    assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));drop(replacement_pin);
    let retry=f.build(Engine::Tantivy);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(retry.generation));assert_eq!(r4_v3_source_sha(&f),source_sha);
    println!("R4 fresh connection collected; different entity/bytes kept; active and complete source SHA kept; limit2 retry built successfully");
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_confirm_sql_failure_keeps_valid_tombstone_before_delete(){
    let mut f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);r4_v3_fixture_stage(&f.conn);
    tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let ownership=fs::read(path.join("ownership.json")).unwrap();let files_sha=r4_v3_files_sha(&path);let entity=r4_v3_journal(&f,old.generation).0;
    f.conn.execute_batch("CREATE TEMP TRIGGER reject_rename_confirm BEFORE UPDATE OF cleanupStage ON kb_snap_managed_entity WHEN NEW.cleanupStage='renameConfirmed' BEGIN SELECT RAISE(ABORT,'r4_confirm_injected'); END;").unwrap();
    let result=gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false));
    assert!(result.as_ref().is_err_and(|e|e.contains("r4_confirm_injected")),"confirm SQL must fail before any physical delete: {result:?}");
    let journal=r4_v3_journal(&f,old.generation);assert_eq!(journal.2,"pending");assert_eq!(journal.3,0);let tombstone=PathBuf::from(journal.1.unwrap());
    assert!(!path.exists());assert!(tombstone.is_dir());assert_eq!(fs::read(tombstone.join("ownership.json")).unwrap(),ownership);assert_eq!(r4_v3_files_sha(&tombstone),files_sha,"confirm failure must retain every file byte, not merely ownership");
    let pins=files::SnapshotPins::new(&tombstone).unwrap();assert_eq!(pins.entity().unwrap(),entity);pins.verify().unwrap();drop(pins);
    let mut rebuilt=String::new();tantivy_engine::visit_primary(&f.conn,&f.lib,current.generation,|_,p|{rebuilt.push_str(p);Ok(())}).unwrap();assert_eq!(rebuilt,"needle original");
    println!("R4 confirm trigger fired after rename, pending persisted; same tombstone entity and ownership retained before deletion");
    r4_v3_restart(&mut f,&[old.generation,current.generation]);fs::create_dir(&path).unwrap();fs::write(path.join("keep"),b"replacement").unwrap();
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!tombstone.exists());assert_eq!(fs::read(path.join("keep")).unwrap(),b"replacement");
    assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"collected");assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_pending_missing_cannot_guess_completed(){
    let f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);r4_v3_fixture_stage(&f.conn);
    tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let entity=r4_v3_journal(&f,old.generation).0;let away=path.with_extension("saved-entity");let tombstone=path.with_file_name(format!("{}.gc-pending",old.generation));
    f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,tombstone.to_string_lossy()]).unwrap();fs::rename(&path,&away).unwrap();
    assert!(!path.exists()&&!tombstone.exists());let result=gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false));
    assert!(result.as_ref().is_err_and(|e|e.contains("INDEX_CLEANUP_PENDING_MISSING")),"pending path is not proof of rename/delete: {result:?}");
    assert_eq!(r4_v3_journal(&f,old.generation).2,"pending");assert_eq!(r4_v3_journal(&f,old.generation).3,0);assert_eq!(files::SnapshotPins::new(&away).unwrap().entity().unwrap(),entity);
    assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));fs::rename(&away,&path).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!path.exists());
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_legacy_migration_twice_and_pending_before_rename(){
    let f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();
    let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let tombstone=path.with_file_name(format!("{}.gc-legacy",old.generation));f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,tombstone.to_string_lossy()]).unwrap();
    let exists:bool=f.conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('kb_snap_managed_entity') WHERE name='cleanupStage')",[],|r|r.get(0)).unwrap();if exists{f.conn.execute_batch("ALTER TABLE kb_snap_managed_entity DROP COLUMN cleanupStage").unwrap();}
    migrate(&f.conn).unwrap();migrate(&f.conn).unwrap();
    let columns:i64=f.conn.query_row("SELECT COUNT(*) FROM pragma_table_info('kb_snap_managed_entity') WHERE name='cleanupStage'",[],|r|r.get(0)).unwrap();assert_eq!(columns,1,"production migration must add stage idempotently to legacy table");
    assert_eq!(r4_v3_journal(&f,old.generation).2,"pending");assert_eq!(r4_v3_journal(&f,old.generation).3,0);assert!(path.is_dir()&&!tombstone.exists());
    gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!path.exists()&&!tombstone.exists());assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_unknown_or_mismatched_stage_fails_closed(){
    for (stage,cleanup) in [("futureStage",None),("renameConfirmed",None),("renameConfirmed",Some("unsafe"))]{
        let f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);r4_v3_fixture_stage(&f.conn);tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let ownership=fs::read(path.join("ownership.json")).unwrap();
        f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupStage=?3,cleanupPath=?4 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,stage,cleanup]).unwrap();
        let result=gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false));assert!(result.is_err(),"unknown/mismatched journal must not delete: {stage} {cleanup:?} {result:?}");
        assert_eq!(r4_v3_journal(&f,old.generation).3,0);assert_eq!(fs::read(path.join("ownership.json")).unwrap(),ownership);assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));
    }
}
#[test]
#[cfg(windows)]
fn repairs_v3_r4_confirmed_existing_tombstone_still_requires_entity(){
    let f=Fixture::new();f.write("a.txt","needle original");let source_sha=r4_v3_source_sha(&f);let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);r4_v3_fixture_stage(&f.conn);tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();
    let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let tombstone=path.with_file_name(format!("{}.gc-entity",old.generation));let entity=r4_v3_journal(&f,old.generation).0;
    f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,tombstone.to_string_lossy()]).unwrap();let mut delete=files::SnapshotDelete::open(&path,&entity).unwrap();delete.rename(&tombstone).unwrap();f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupStage='renameConfirmed' WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation]).unwrap();drop(delete);
    let away=tombstone.with_extension("saved-entity");fs::rename(&tombstone,&away).unwrap();fs::create_dir(&tombstone).unwrap();fs::write(tombstone.join("keep"),b"different tombstone").unwrap();
    assert!(gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap_err().contains("ENTITY_CHANGED"));assert_eq!(r4_v3_journal(&f,old.generation).3,0);assert_eq!(fs::read(tombstone.join("keep")).unwrap(),b"different tombstone");assert_eq!(r4_v3_source_sha(&f),source_sha);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));
    fs::remove_file(tombstone.join("keep")).unwrap();fs::remove_dir(&tombstone).unwrap();fs::rename(&away,&tombstone).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!tombstone.exists());
}
#[test]
#[cfg(windows)]
fn repairs_v2_r4_tombstone_recovery_ignores_original_path_replacement(){
    let f=Fixture::new();f.write("a.txt","needle original");let old=f.build(Engine::Tantivy);let current=f.build(Engine::Tantivy);tantivy_engine::forget(&f.conn,&f.lib,old.generation).unwrap();
    let path=tantivy_engine::location(&f.conn,&f.lib,old.generation).unwrap();let entity:String=f.conn.query_row("SELECT entityId FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation],|r|r.get(0)).unwrap();
    let tombstone=path.with_file_name(format!("{}.gc-recovery",old.generation));f.conn.execute("UPDATE kb_snap_managed_entity SET cleanupPath=?3 WHERE libraryId=?1 AND generation=?2",params![f.lib,old.generation,tombstone.to_string_lossy()]).unwrap();
    let mut delete=files::SnapshotDelete::open(&path,&entity).unwrap();delete.rename(&tombstone).unwrap();drop(delete);
    // Equivalent persisted interruption point: no live deletion handle, SQL records actual entity.
    fs::create_dir(&path).unwrap();fs::write(path.join("keep"),b"replacement").unwrap();recover_interrupted(&f.conn).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    assert!(!tombstone.exists());assert_eq!(fs::read(path.join("keep")).unwrap(),b"replacement");assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[old.generation],|r|r.get::<_,String>(0)).unwrap(),"collected");assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle original");
}
#[test]
#[cfg(windows)]
fn repairs_v2_r4_registration_failure_rolls_back_created_entity(){
    let f=Fixture::new();let body=b"needle original";f.write("a.txt",body);let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);
    f.conn.execute_batch("CREATE TEMP TRIGGER reject_entity BEFORE INSERT ON kb_snap_managed_entity BEGIN SELECT RAISE(ABORT,'registered_entity_injected'); END;").unwrap();
    let error=build_snapshot(&f.conn,&spec,&AtomicBool::new(false),&Fixture::limits()).unwrap_err();
    assert!(error.contains("registered_entity_injected")&&error.contains("created_entity_rollback=Ok"),"{error}");
    assert!(!tantivy_engine::location(&f.conn,&f.lib,spec.generation).unwrap().exists());assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
    terminal(&f.conn,&spec,"failed",&error).unwrap();f.conn.execute_batch("DROP TRIGGER reject_entity").unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
    let retry=f.build(Engine::Tantivy);assert_eq!(f.search("needle").0[0].snapshot_generation,Some(retry.generation));assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),body);
}
#[test]
fn repairs_v2_r4_ownership_initialization_failures_reclaim_registered_entity(){
    use tantivy_engine::io_faults::{self,Fault};
    for mode in [Fault::OwnershipOpen,Fault::OwnershipPartial,Fault::OwnershipFlush]{
        let f=Fixture::new();let body=b"needle original";f.write("a.txt",body);let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);
        let guard=io_faults::arm(mode);let error=build_snapshot(&f.conn,&spec,&AtomicBool::new(false),&Fixture::limits()).unwrap_err();assert!(guard.fired());drop(guard);terminal(&f.conn,&spec,"failed",&error).unwrap();
        assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).expect("ownership failure must not strand the failed generation");
        assert!(!tantivy_engine::location(&f.conn,&f.lib,spec.generation).unwrap().exists());let retry=f.build(Engine::Tantivy);
        assert_eq!(f.search("needle").0[0].snapshot_generation,Some(retry.generation));assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),body);
    }
}
#[test]
fn repairs_v2_r5_early_worker_failure_drains_original_result(){
    use tantivy_engine::io_faults::{self,Fault};
    let f=Fixture::new();let body="needle full source proof\r\n".repeat(15000);f.write("a.txt",&body);let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);
    // Force a real persistent host cancellation before taking the Writer, so an
    // optimized copy cannot turn this early-error regression into a commit test.
    BEFORE_ENGINE_PREPARE.with(|hook|*hook.borrow_mut()=Some(Box::new(|conn,spec|{
        conn.execute("UPDATE kb_snap_job SET cancelRequested=1 WHERE id=?1",[&spec.id]).unwrap();
    })));
    let guard=io_faults::arm(Fault::Enospc);let result=build_snapshot(&f.conn,&spec,&AtomicBool::new(false),&Fixture::limits());
    BEFORE_ENGINE_PREPARE.with(|hook|{hook.borrow_mut().take();});
    let error=result.unwrap_err();assert!(guard.fired());drop(guard);
    assert!(error.contains("engine_prepare=")&&error.contains("engine_join="),"early error lost explicit worker drain: {error}");
    let prepare=error.split("; engine_prepare=").nth(1).unwrap();assert!(!prepare.starts_with("Ok")&&!prepare.starts_with("INDEX_ENGINE: An error occurred in a thread"),"original worker error was replaced by a generic thread error: {error}");
    assert!(prepare.contains("112")||prepare.contains("28"),"original worker I/O error lost: {error}");println!("R5 early host+original drain: {error}");terminal(&f.conn,&spec,"failed",&error).unwrap();
    assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(f.build(Engine::Tantivy).generation>old.generation);assert_eq!(Sha256::digest(fs::read(f.root.join("a.txt")).unwrap()),Sha256::digest(body.as_bytes()));
}
#[test]
fn repairs_v2_r5_host_and_commit_worker_error_both_survive(){
    use tantivy_engine::io_faults::{self,Fault};
    let f=Fixture::new();let body="needle original";f.write("a.txt",body);let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);let guard=io_faults::arm(Fault::Enospc);
    let writer=tantivy_engine::Writer::create(&f.conn,&spec).unwrap();let hash=hash_reader(&mut fs::File::open(f.root.join("a.txt")).unwrap(),&AtomicBool::new(false)).unwrap();
    let chunk=StreamChunk{ordinal:0,start:0,end:body.len()as u64,start_line:1,end_line:1,text:body.into(),heading:String::new()};
    let meta=tantivy_engine::Meta::new(&spec,&files::file_id("a.txt"),"test-parse","a.txt","a.txt",&hash,1,&chunk,"","body");let(body_terms,bigram)=kb_index::body_terms_for(body);let terms=kb_index::ChunkTerms{title:"a".into(),heading:String::new(),body:body_terms,bigram};writer.add(&meta,body,"",&terms).unwrap();
    let error=writer.commit_monitored(&f.conn,&spec,&AtomicBool::new(false),&Limits{disk_bytes:1,..Fixture::limits()}).err().unwrap();assert!(guard.fired());drop(guard);
    assert!(error.starts_with("INDEX_DISK_QUOTA")&&error.contains("engine_result=Err")&&(error.contains("112")||error.contains("28")),"host error erased engine result: {error}");
    terminal(&f.conn,&spec,"failed",&error).unwrap();assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();f.build(Engine::Tantivy);assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),body.as_bytes());
}
#[test]
fn repairs_v2_r5_non_directory_worker_panic_payload_survives(){
    use tantivy_engine::io_faults::{self,Fault};
    let f=Fixture::new();let body="needle original\r\n".repeat(1000);f.write("a.txt",&body);let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);let guard=io_faults::arm(Fault::WorkerTokenPanic);
    let error=build_snapshot(&f.conn,&spec,&AtomicBool::new(false),&Fixture::limits()).unwrap_err();assert!(guard.fired());drop(guard);
    assert!(error.contains("non_directory_tokenizer_worker_panic")&&error.contains("worker_panic"),"worker panic payload lost: {error}");assert!(error.contains("[truncated]")&&error.len()<16384,"panic diagnostic must stay bounded and preserve UTF8");
    terminal(&f.conn,&spec,"failed",&error).unwrap();assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();f.build(Engine::Tantivy);assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),body.as_bytes());
}
#[cfg(windows)]
fn perf_v1_tree_sha(path:&Path)->std::collections::BTreeMap<String,String>{
    walkdir::WalkDir::new(path).into_iter().map(Result::unwrap).filter(|e|e.file_type().is_file()).map(|e|(e.path().strip_prefix(path).unwrap().to_string_lossy().into_owned(),format!("{:x}",Sha256::digest(fs::read(e.path()).unwrap())))).collect()
}
#[test]
#[cfg(windows)]
#[ignore="explicit read-only settled formal 64MiB probe; never counted as passed when skipped"]
fn perf_v1_probe_existing_formal_64mib_verified(){
    let db=PathBuf::from(std::env::var_os("CR055_PERF_PROBE_DB").expect("explicit settled benchmark DB"));
    assert_eq!(db.file_name().unwrap(),"snapshot.sqlite");assert_eq!(db.parent().unwrap().file_name().unwrap(),"64mib-tantivy");
    assert!(!PathBuf::from(format!("{}-wal",db.display())).exists());assert!(!PathBuf::from(format!("{}-shm",db.display())).exists());
    let out=PathBuf::from(std::env::var_os("CR055_PERF_PROBE_OUTPUT").expect("new isolated output"));assert!(!out.exists());
    let before=perf_v1_tree_sha(db.parent().unwrap());
    let uri=format!("file:{}?mode=ro&immutable=1",db.to_string_lossy().replace('\\',"/"));
    let conn=Connection::open_with_flags(uri,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_URI).unwrap();conn.execute_batch("PRAGMA query_only=ON;").unwrap();
    let lib="formal-benchmark-library";let snap=active_snapshot(&conn,lib).unwrap().unwrap();
    let(count,bytes):(i64,i64)=conn.query_row("SELECT COUNT(*),SUM(CAST(sourceSize AS INTEGER)) FROM kb_snap_member WHERE libraryId=?1 AND generation=?2",params![lib,snap.generation],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!((count,bytes),(313,67216437));
    let source=PathBuf::from(performance::source_ref(&conn,lib).unwrap());let manifest:serde_json::Value=serde_json::from_slice(&fs::read(source.parent().unwrap().join("manifest.json")).unwrap()).unwrap();
    let mut expected=HashMap::new();let proof_start=Instant::now();
    for e in manifest["files"].as_array().unwrap(){let relative=e["relative"].as_str().unwrap();let(size,sha):(String,String)=conn.query_row("SELECT sourceSize,sourceHash FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND relativeUri=?3",params![lib,snap.generation,relative],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(size.parse::<u64>().unwrap(),e["bytes"].as_u64().unwrap());assert_eq!(sha.strip_prefix("sha256:"),e["sha256"].as_str());let mut safe=files::SafeRoot::new(&source).unwrap();let raw=hash_reader(&mut files::open_snapshot(&mut safe,relative).unwrap(),&AtomicBool::new(false)).unwrap();safe.verify().unwrap();assert_eq!(raw.sha256,sha);assert_eq!(raw.bytes,e["bytes"].as_u64().unwrap());expected.insert(relative.to_string(),(raw.bytes,sha));}
    let raw_seconds=proof_start.elapsed().as_secs_f64();let mut runs=Vec::new();
    tantivy_engine::forget(&conn,lib,snap.generation).unwrap();
    for pass in 0..3 {tantivy_engine::CACHE_STATS.with(|s|*s.borrow_mut()=tantivy_engine::CacheStats::default());let start=Instant::now();let result=verified::search(&conn,Some("benchmark-project"),"中文索引").unwrap();let wall_ms=start.elapsed().as_secs_f64()*1000.0;let hits=result["hits"].as_array().unwrap();assert!(!hits.is_empty());assert!(hits.iter().all(|h|h["sourceVerified"]==true));let stats=tantivy_engine::CACHE_STATS.with(|s|s.borrow().clone());println!("PERF_V1_FORMAL pass={pass} wall_ms={wall_ms} {}",serde_json::to_string(&stats).unwrap());runs.push(serde_json::json!({"pass":pass,"wallMs":wall_ms,"stats":stats,"gateway":result}));}
    let start=Instant::now();let mut rebuilt:HashMap<String,(Sha256,u64,usize)>=HashMap::new();
    tantivy_engine::visit_primary(&conn,lib,snap.generation,|m,text|{let e=rebuilt.entry(m.relative_uri.clone()).or_insert_with(||(Sha256::new(),0,0));assert_eq!(e.1,m.start);assert_eq!(e.2,m.ordinal);assert_eq!(m.end-m.start,text.len()as u64);e.0.update(text.as_bytes());e.1=m.end;e.2+=1;Ok(())}).unwrap();assert_eq!(rebuilt.len(),313);
    for(relative,(sha,size,_))in rebuilt{assert_eq!(expected[&relative],(size,format!("sha256:{:x}",sha.finalize())));}
    let primary_seconds=start.elapsed().as_secs_f64();tantivy_engine::forget(&conn,lib,snap.generation).unwrap();drop(conn);
    assert_eq!(perf_v1_tree_sha(db.parent().unwrap()),before,"read-only probe changed settled benchmark files");assert!(!PathBuf::from(format!("{}-wal",db.display())).exists());assert!(!PathBuf::from(format!("{}-shm",db.display())).exists());
    let report=serde_json::json!({"db":db,"sourceFiles":count,"sourceBytes":bytes,"manifestIdentity":manifest["manifestSha256"],"rawFullShaValidated":true,"fullPrimaryValidated":true,"rawValidationSeconds":raw_seconds,"fullPrimaryValidationSeconds":primary_seconds,"readOnlyFilesUnchanged":true,"metadataFinalFence":"actual unchanged verified::search production path","runs":runs});
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(out).unwrap();use std::io::Write;file.write_all(&serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
#[test]
fn perf_v1_warm_ten_loads_keep_sql_store_proof_without_reopening_files(){
    let f=Fixture::new();let body="needle 完整正文\r\n".repeat(1000);f.write("a.txt",&body);let spec=f.build(Engine::Tantivy);
    let key=f.search("needle").0[0].chunk_key;
    tantivy_engine::CACHE_STATS.with(|s|*s.borrow_mut()=tantivy_engine::CacheStats::default());
    let start=Instant::now();for _ in 0..10{let(meta,primary,suffix)=tantivy_engine::load(&f.conn,&f.lib,spec.generation,key).unwrap();assert_eq!(meta.source_hash,format!("sha256:{:x}",Sha256::digest(body.as_bytes())));assert_eq!(meta.primary_sha,format!("sha256:{:x}",Sha256::digest(primary.as_bytes())));assert_eq!(meta.suffix_sha,format!("sha256:{:x}",Sha256::digest(suffix.as_bytes())));}
    let stats=tantivy_engine::CACHE_STATS.with(|s|s.borrow().clone());println!("PERF_V1_WARM {} wall_ms={}",serde_json::to_string(&stats).unwrap(),start.elapsed().as_secs_f64()*1000.0);
    assert_eq!(stats.loads,10);assert_eq!(stats.cold_fullhashfiles,0);assert!(stats.heldmetadata>=10);
    #[cfg(windows)] assert_eq!(stats.pin_opens,0,"warm Ready must reuse continuously held files, not reopen every generation file");
    assert_eq!(Sha256::digest(fs::read(f.root.join("a.txt")).unwrap()),Sha256::digest(body.as_bytes()));
}
#[test]
fn perf_v1_cached_sql_anchors_versions_path_and_meta_fail_closed(){
    use rusqlite::types::Value;
    let f=Fixture::new();f.write("a.txt","needle immutable source");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let before=fs::read(f.root.join("a.txt")).unwrap();
    for(field,bad)in [("engineSealHash",Value::Text("sha256:wrong".into())),("engineSealHash",Value::Null),("manifestDigest",Value::Text("wrong".into())),("manifestDigest",Value::Null),("enginePath",Value::Text(f.root.to_string_lossy().into_owned())),("enginePath",Value::Null),("engineKind",Value::Text("unknown".into())),("engineSchemaVersion",Value::Integer(999)),("tokenizerVersion",Value::Text("unknown".into())),("engineFormat",Value::Text("unknown".into())),("engineOptionsHash",Value::Text("unknown".into()))]{
        let good:Value=f.conn.query_row(&format!("SELECT {field} FROM kb_snap_generation WHERE id=?1"),[s.generation],|r|r.get(0)).unwrap();
        let ready=tantivy_engine::perf_cached_ready(&path).unwrap();
        f.conn.execute(&format!("UPDATE kb_snap_generation SET {field}=?2 WHERE id=?1"),params![s.generation,bad]).unwrap();
        tantivy_engine::CACHE_STATS.with(|x|*x.borrow_mut()=Default::default());
        let error=tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err();assert!(!error.is_empty(),"{field}");
        assert_eq!(tantivy_engine::CACHE_STATS.with(|x|x.borrow().cold_fullhashfiles),0,"bad anchor must not reload: {field}");
        assert!(Arc::ptr_eq(&ready,&tantivy_engine::perf_cached_ready(&path).unwrap()));
        println!("PERF_V1_SQL rejected {field}={bad:?}: {error}");
        f.conn.execute(&format!("UPDATE kb_snap_generation SET {field}=?2 WHERE id=?1"),params![s.generation,good]).unwrap();
        assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_ok());
    }
    let original:String=f.conn.query_row("SELECT sourceHash FROM kb_snap_member WHERE generation=?1",[s.generation],|r|r.get(0)).unwrap();
    f.conn.execute("UPDATE kb_snap_member SET sourceHash='sha256:forged' WHERE generation=?1",[s.generation]).unwrap();
    assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("METADATA_MISMATCH"));
    f.conn.execute("UPDATE kb_snap_member SET sourceHash=?2 WHERE generation=?1",params![s.generation,original]).unwrap();
    assert!(verified::search(&f.conn,Some("p"),"needle").unwrap()["hits"].as_array().unwrap().iter().all(|h|h["sourceVerified"]==true));
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),before);
}
#[test]
#[cfg(windows)]
fn perf_v1_live_files_and_preexisting_write_delete_handles_are_blocked(){
    use std::os::windows::fs::OpenOptionsExt;
    let f=Fixture::new();f.write("a.txt","needle real handles");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    let seal:serde_json::Value=serde_json::from_slice(&fs::read(path.join("sealed.json")).unwrap()).unwrap();
    let names=std::iter::once("sealed.json").chain(seal["files"].as_array().unwrap().iter().map(|e|e["name"].as_str().unwrap()));
    for name in names{let p=path.join(name);assert!(fs::OpenOptions::new().write(true).share_mode(7).open(&p).is_err(),"WRITE {name}");assert!(fs::OpenOptions::new().access_mode(0x10000).share_mode(7).open(&p).is_err(),"DELETE access {name}");assert!(fs::remove_file(&p).is_err(),"DELETE {name}");assert!(fs::rename(&p,p.with_extension("away")).is_err(),"rename {name}");}
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();let p=path.join("sealed.json");
    for access in [0x40000000,0x10000]{let attacker=fs::OpenOptions::new().access_mode(access).share_mode(7).open(&p).unwrap();assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_err(),"first acquisition accepted existing write/delete handle");assert!(tantivy_engine::perf_cached_ready(&path).is_none());drop(attacker);assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_ok());tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();}
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle real handles");println!("PERF_V1_HANDLES all sealed files WRITE/DELETE/rename blocked; preexisting WRITE and DELETE denied at cold acquisition");
}
#[test]
#[cfg(windows)]
fn perf_v1_warm_inventory_and_cold_same_length_corruption_fail_closed(){
    let f=Fixture::new();f.write("a.txt","needle unchanged source");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let baseline=perf_v1_tree_sha(&path);
    let extra=path.join("unsealed-extra");fs::write(&extra,b"unknown").unwrap();assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("SEAL_INCOMPLETE"));fs::remove_file(&extra).unwrap();
    fs::create_dir(&extra).unwrap();assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("UNSAFE"));fs::remove_dir(&extra).unwrap();
    let junction=std::process::Command::new("cmd.exe").args(["/D","/C","mklink","/J"]).arg(&extra).arg(&f.root).output().unwrap();assert!(junction.status.success(),"isolated junction creation failed: {junction:?}");assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("UNSAFE"));assert!(unsafe_entry(&fs::symlink_metadata(&extra).unwrap()));fs::remove_dir(&extra).unwrap();
    assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_ok());tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();
    let seal_path=path.join("sealed.json");let bytes=fs::read(&seal_path).unwrap();let seal:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
    let store=path.join(seal["files"].as_array().unwrap().iter().find(|e|e["name"].as_str().unwrap().ends_with(".store")).unwrap()["name"].as_str().unwrap());
    let original=fs::read(&store).unwrap();let mut bad=original.clone();bad[0]^=1;fs::write(&store,&bad).unwrap();assert_eq!(bad.len(),original.len());assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("FILE_HASH_MISMATCH"));fs::write(&store,&original).unwrap();
    fs::rename(&store,store.with_extension("missing")).unwrap();assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_err());fs::rename(store.with_extension("missing"),&store).unwrap();
    let mut forged=seal.clone();forged["digest"]=serde_json::json!("forged");fs::write(&seal_path,serde_json::to_vec(&forged).unwrap()).unwrap();assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap_err().contains("SEAL_UNTRUSTED"));fs::write(&seal_path,&bytes).unwrap();
    assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_ok());assert!(fs::write(&seal_path,&bytes).is_err(),"live seal must not be strongly replaced");
    assert_eq!(perf_v1_tree_sha(&path),baseline);assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle unchanged source");
}
#[test]
#[cfg(windows)]
fn perf_v1_concurrent_connections_held_offsets_cold_insert_and_forget(){
    let f=Fixture::new();let body="needle independent offset 中文\r\n".repeat(1500);f.write("a.txt",&body);let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let bytes=fs::read(path.join("sealed.json")).unwrap();let baseline=perf_v1_tree_sha(&path);
    for cold in [false,true]{if cold{tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();}let barrier=Arc::new(std::sync::Barrier::new(2));let mut workers=Vec::new();
        for _ in 0..2{let barrier=barrier.clone();let db=f.work.join("test.db");let lib=f.lib.clone();let bytes=bytes.clone();let body=body.clone();let g=s.generation;
            workers.push(std::thread::spawn(move||{let conn=Connection::open(db).unwrap();barrier.wait();let ready=tantivy_engine::perf_open(&conn,&lib,g).unwrap();
                tantivy_engine::CACHE_STATS.with(|x|*x.borrow_mut()=Default::default());for _ in 0..100{assert_eq!(tantivy_engine::perf_read_held_seal(&ready).unwrap(),bytes);let(meta,primary,suffix)=tantivy_engine::load(&conn,&lib,g,key).unwrap();assert_eq!(meta.source_hash,format!("sha256:{:x}",Sha256::digest(body.as_bytes())));assert_eq!(meta.primary_sha,format!("sha256:{:x}",Sha256::digest(primary.as_bytes())));assert_eq!(meta.suffix_sha,format!("sha256:{:x}",Sha256::digest(suffix.as_bytes())));}
                let stats=tantivy_engine::CACHE_STATS.with(|x|x.borrow().clone());assert_eq!(stats.pin_opens,0);assert_eq!(stats.cold_fullhashfiles,0);(ready,stats)
            }));}
        let a=workers.remove(0).join().unwrap();let b=workers.remove(0).join().unwrap();assert!(Arc::ptr_eq(&a.0,&b.0),"concurrent cold insert must return same checked cache entry");
        tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();assert!(fs::remove_file(path.join("sealed.json")).is_err(),"forget must not unpin checked outstanding Arc");assert_eq!(tantivy_engine::perf_read_held_seal(&a.0).unwrap(),bytes);drop(a);drop(b);
        assert!(tantivy_engine::load(&f.conn,&f.lib,s.generation,key).is_ok());println!("PERF_V1_CONCURRENT cold={cold}: 2 connections x100 loads, independent offset exact bytes, Arc survives forget");
    }
    assert_eq!(perf_v1_tree_sha(&path),baseline);assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),body.as_bytes());
}
#[test]
#[cfg(windows)]
fn perf_v1_cache_ttl_fresh_restart_and_bad_expired_state(){
    let f=Fixture::new();f.write("a.txt","needle TTL source");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    let old=tantivy_engine::perf_cached_ready(&path).unwrap();tantivy_engine::perf_expire_cache(&path);tantivy_engine::CACHE_STATS.with(|x|*x.borrow_mut()=Default::default());let new=tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).unwrap();assert!(!Arc::ptr_eq(&old,&new));assert!(tantivy_engine::CACHE_STATS.with(|x|x.borrow().cold_fullhashfiles)>0);drop(old);drop(new);
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();let conn=Connection::open(f.work.join("test.db")).unwrap();assert!(tantivy_engine::load(&conn,&f.lib,s.generation,key).is_ok());
    tantivy_engine::perf_expire_cache(&path);f.conn.execute("UPDATE kb_snap_generation SET engineSealHash='sha256:bad-expired' WHERE id=?1",[s.generation]).unwrap();assert!(tantivy_engine::load(&conn,&f.lib,s.generation,key).unwrap_err().contains("SEAL_UNTRUSTED"));assert!(tantivy_engine::perf_cached_ready(&path).is_none());
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle TTL source");
}
#[test]
#[cfg(windows)]
fn perf_v1_cache_eight_eviction_preserves_live_arc(){
    let mut fixtures=Vec::new();let mut first=None;
    for i in 0..9{let f=Fixture::new();f.write("a.txt",format!("needle cache-{i}"));let s=f.build(Engine::Tantivy);assert!(!f.search("needle").0.is_empty());let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();if i==0{first=Some((path.clone(),tantivy_engine::perf_cached_ready(&path).unwrap(),fs::read(path.join("sealed.json")).unwrap()));}assert!(tantivy_engine::perf_cache_len()<=8);fixtures.push(f);}
    let(path,ready,bytes)=first.unwrap();assert!(tantivy_engine::perf_cached_ready(&path).is_none(),"oldest ninth insertion must evict first");assert!(fs::remove_file(path.join("sealed.json")).is_err(),"eviction released live Arc pins");assert_eq!(tantivy_engine::perf_read_held_seal(&ready).unwrap(),bytes);drop(ready);assert!(fs::OpenOptions::new().write(true).open(path.join("sealed.json")).is_ok());drop(fixtures);
}
#[test]
#[cfg(windows)]
fn perf_v2_fresh_batch_bounds_identity_and_warm_counts(){
    let f=Fixture::new();f.write("a.txt","needle fresh bounded batch");let s=f.build(Engine::Tantivy);let key=f.search("needle").0[0].chunk_key;
    let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let pins=files::SnapshotPins::new(&path).unwrap();let seal=path.join("sealed.json");let file=pins.file(&seal,false).unwrap();let entity=files::snapshot_entity_id(&file).unwrap();
    let n=pins.checked_read_files(&[(seal.clone(),entity.clone())],|fresh|{assert_eq!(fresh.len(),1);assert!(fs::write(&seal,b"bad").is_err());Ok(fresh.len())}).unwrap();assert_eq!(n,(1,1));
    assert!(pins.checked_read_files(&[(seal.clone(),"wrong entity".into())],|_|Ok(())).unwrap_err().contains("ENTITY_CHANGED"));
    assert!(pins.checked_read_files(&[],|_|Ok(())).unwrap_err().contains("BATCH_LIMIT"));
    let too_many=vec![(seal.clone(),entity.clone());4097];assert!(pins.checked_read_files(&too_many,|_| -> Result<(),String>{panic!("oversized callback")}).unwrap_err().contains("BATCH_LIMIT"));
    assert!(pins.checked_read_files(&[(f.root.join("a.txt"),entity)],|_|Ok(())).is_err());
    let manifest:serde_json::Value=serde_json::from_slice(&fs::read(&seal).unwrap()).unwrap();let count=manifest["files"].as_array().unwrap().len()+1;
    tantivy_engine::CACHE_STATS.with(|x|*x.borrow_mut()=Default::default());for _ in 0..10{tantivy_engine::load(&f.conn,&f.lib,s.generation,key).unwrap();}
    let stats=tantivy_engine::CACHE_STATS.with(|x|x.borrow().clone());assert_eq!(stats.loads,10);assert_eq!(stats.fresh_batch_files,count as u64*10);assert_eq!(stats.batch_ancestor_verifies,20);assert_eq!(stats.pin_opens,0);assert_eq!(stats.cold_fullhashfiles,0);
    println!("PERF_V2_BATCH {} files_per_logical_open={count}; pin_opens only legacy pins.file calls, NOT all OS opens",serde_json::to_string(&stats).unwrap());
}
#[cfg(windows)]
mod perf_v2_native {
    use super::*;use std::ffi::c_void;use std::os::windows::{ffi::OsStrExt,fs::OpenOptionsExt,io::AsRawHandle};
    type Handle=*mut c_void;
    #[repr(C)] struct Trustee {multiple:*mut Trustee,operation:u32,form:u32,kind:u32,name:*mut u16}
    #[repr(C)] struct Explicit {permissions:u32,mode:u32,inheritance:u32,trustee:Trustee}
    #[link(name="advapi32")] extern "system" {
        fn GetNamedSecurityInfoW(name:*mut u16,kind:u32,info:u32,owner:*mut Handle,group:*mut Handle,dacl:*mut Handle,sacl:*mut Handle,descriptor:*mut Handle)->u32;
        fn SetNamedSecurityInfoW(name:*mut u16,kind:u32,info:u32,owner:Handle,group:Handle,dacl:Handle,sacl:Handle)->u32;
        fn SetEntriesInAclW(count:u32,entries:*mut Explicit,old:Handle,new:*mut Handle)->u32;
        fn ConvertStringSidToSidW(sid:*const u16,result:*mut Handle)->i32;
        fn GetSecurityDescriptorControl(sd:Handle,control:*mut u16,revision:*mut u32)->i32;
    }
    #[link(name="kernel32")] extern "system" {
        fn LocalFree(memory:Handle)->Handle;
        fn CreateFileMappingW(file:Handle,attributes:Handle,protect:u32,high:u32,low:u32,name:*const u16)->Handle;
        fn MapViewOfFile(section:Handle,access:u32,high:u32,low:u32,bytes:usize)->Handle;
        fn UnmapViewOfFile(view:*const c_void)->i32;
        fn CloseHandle(handle:Handle)->i32;
        fn FlushViewOfFile(view:*const c_void,bytes:usize)->i32;
    }
    pub struct Dacl {wide:Vec<u16>,sd:Handle,old:Handle,restore_info:u32,restored:bool}
    impl Dacl {
        pub fn deny_read_data(path:&Path,isolated_root:&Path)->Self{
            assert!(fs::canonicalize(path).unwrap().starts_with(fs::canonicalize(isolated_root).unwrap())&&path.is_file(),"ACL scope must be this new temporary fixture only");
            let mut wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();let(mut sd,mut old)=(std::ptr::null_mut(),std::ptr::null_mut());
            let code=unsafe{GetNamedSecurityInfoW(wide.as_mut_ptr(),1,4,std::ptr::null_mut(),std::ptr::null_mut(),&mut old,std::ptr::null_mut(),&mut sd)};assert_eq!(code,0,"cannot capture temporary DACL; unverified OS error {code}");
            let(mut control,mut revision)=(0,0);assert_ne!(unsafe{GetSecurityDescriptorControl(sd,&mut control,&mut revision)},0);
            let guard=Self{wide,sd,old,restore_info:4|if control&0x1000!=0{0x80000000}else{0x20000000},restored:false};
            let output=std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]).output().unwrap();assert!(output.status.success());let sid_text=String::from_utf8(output.stdout).unwrap();let sid_text=sid_text.trim();assert!(sid_text.starts_with("S-1-"));
            let sid_wide:Vec<u16>=sid_text.encode_utf16().chain(Some(0)).collect();let mut sid=std::ptr::null_mut();assert_ne!(unsafe{ConvertStringSidToSidW(sid_wide.as_ptr(),&mut sid)},0);
            let mut entry=Explicit{permissions:1,mode:3,inheritance:0,trustee:Trustee{multiple:std::ptr::null_mut(),operation:0,form:0,kind:1,name:sid.cast()}};let mut new=std::ptr::null_mut();let code=unsafe{SetEntriesInAclW(1,&mut entry,guard.old,&mut new)};unsafe{LocalFree(sid);};assert_eq!(code,0,"temporary deny RD ACL creation failed");
            let mut guard=guard;let code=unsafe{SetNamedSecurityInfoW(guard.wide.as_mut_ptr(),1,4,std::ptr::null_mut(),std::ptr::null_mut(),new,std::ptr::null_mut())};unsafe{LocalFree(new);};assert_eq!(code,0,"temporary deny RD ACL apply failed; not a PASS");
            println!("PERF_V2_DACL deny mask=0x1 FILE_READ_DATA only; current SID; temporary fixture only");guard
        }
        pub fn restore(&mut self){let code=unsafe{SetNamedSecurityInfoW(self.wide.as_mut_ptr(),1,self.restore_info,std::ptr::null_mut(),std::ptr::null_mut(),self.old,std::ptr::null_mut())};assert_eq!(code,0,"temporary DACL RESTORE FAILED {code}");self.restored=true;}
    }
    impl Drop for Dacl {fn drop(&mut self){if !self.restored{let code=unsafe{SetNamedSecurityInfoW(self.wide.as_mut_ptr(),1,self.restore_info,std::ptr::null_mut(),std::ptr::null_mut(),self.old,std::ptr::null_mut())};if code!=0{eprintln!("PERF_V2_DACL finally RESTORE FAILED {code}");if !std::thread::panicking(){panic!("DACL restore failed");}}}unsafe{LocalFree(self.sd);};}}
    pub fn attributes(path:&Path)->std::io::Result<fs::File>{fs::OpenOptions::new().access_mode(0x80).share_mode(7).custom_flags(0x200000).open(path)}
    pub fn read_data(path:&Path)->std::io::Result<fs::File>{fs::OpenOptions::new().access_mode(1).share_mode(1).custom_flags(0x200000).open(path)}
    pub struct Mapping {section:Handle,view:Handle}
    impl Mapping {
        pub fn new(file:&fs::File)->Self{let section=unsafe{CreateFileMappingW(file.as_raw_handle(),std::ptr::null_mut(),4,0,0,std::ptr::null())};println!("PERF_V2_MAPPING PAGE_READWRITE section success={} error={:?}",!section.is_null(),std::io::Error::last_os_error());assert!(!section.is_null());let view=unsafe{MapViewOfFile(section,2,0,0,0)};if view.is_null(){unsafe{CloseHandle(section);};panic!("FILE_MAP_WRITE view failed {:?}",std::io::Error::last_os_error());}println!("PERF_V2_MAPPING FILE_MAP_WRITE view success=true");Self{section,view}}
        pub fn write_byte(&self,value:u8){unsafe{std::ptr::write_volatile(self.view.cast::<u8>(),value);assert_ne!(FlushViewOfFile(self.view,1),0);}}
        pub fn assert_read_handle_cannot_map_write(file:&fs::File){let section=unsafe{CreateFileMappingW(file.as_raw_handle(),std::ptr::null_mut(),4,0,0,std::ptr::null())};let error=std::io::Error::last_os_error();if !section.is_null(){unsafe{CloseHandle(section);};}assert!(section.is_null(),"READ-only handle allowed writable mapping");println!("PERF_V2_MAPPING readonly PAGE_READWRITE rejected {error}");}
    }
    impl Drop for Mapping {fn drop(&mut self){unsafe{UnmapViewOfFile(self.view);CloseHandle(self.section);};}}
}
#[test]
#[cfg(windows)]
fn perf_v2_real_read_data_dacl_revocation_rejects_cached_ready(){
    use perf_v2_native::*;
    let f=Fixture::new();f.write("a.txt","needle DACL unchanged source");let s=f.build(Engine::Tantivy);f.search("needle");let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();let before=perf_v1_tree_sha(&path);
    let manifest:serde_json::Value=serde_json::from_slice(&fs::read(path.join("sealed.json")).unwrap()).unwrap();
    let store=manifest["files"].as_array().unwrap().iter().find(|e|e["name"].as_str().unwrap().ends_with(".store")).unwrap()["name"].as_str().unwrap();
    for name in ["sealed.json","ownership.json",store]{
        let target=path.join(name);assert!(attributes(&target).is_ok());assert!(read_data(&target).is_ok());let held=read_data(&target).unwrap();let ready=tantivy_engine::perf_cached_ready(&path).unwrap();
        let mut guard=Dacl::deny_read_data(&target,&f.work);
        assert!(attributes(&target).is_ok(),"deny READ_DATA must NOT deny READ_ATTRIBUTES");assert!(fs::symlink_metadata(&target).is_ok());assert!(held.metadata().is_ok());
        let error=read_data(&target).err().expect("fresh READ_DATA remained allowed");assert_eq!(error.raw_os_error(),Some(5));
        let error=tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).err().expect("cached Ready bypassed current RD DACL");assert!(error.contains("INDEX_FRESH_READ_OPEN")&&error.contains("5"),"must reach fresh DACL route, not inventory/attrs: {error}");
        assert!(Arc::ptr_eq(&ready,&tantivy_engine::perf_cached_ready(&path).unwrap()));println!("PERF_V2_DACL {name}: attributes=true held_metadata=true fresh_mask1=OS5 cached={error}");
        guard.restore();assert!(read_data(&target).is_ok());assert!(tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).is_ok());
    }
    assert_eq!(perf_v1_tree_sha(&path),before);assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle DACL unchanged source");
}
#[test]
#[cfg(windows)]
fn perf_v2_real_writable_mapping_blocks_cold_pins_and_readonly_mapping(){
    use std::os::windows::fs::OpenOptionsExt;use perf_v2_native::*;
    let f=Fixture::new();f.write("a.txt","needle mapping unchanged source");let s=f.build(Engine::Tantivy);f.search("needle");let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
    let manifest:serde_json::Value=serde_json::from_slice(&fs::read(path.join("sealed.json")).unwrap()).unwrap();let name=manifest["files"].as_array().unwrap().iter().find(|e|e["name"].as_str().unwrap().ends_with(".store")).unwrap()["name"].as_str().unwrap();let target=path.join(name);let original=fs::read(&target).unwrap();
    assert!(fs::OpenOptions::new().read(true).write(true).share_mode(7).open(&target).is_err());let r=read_data(&target).unwrap();Mapping::assert_read_handle_cannot_map_write(&r);drop(r);
    tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();let writer=fs::OpenOptions::new().read(true).write(true).share_mode(7).open(&target).unwrap();let mapping=Mapping::new(&writer);
    let error=tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).err().expect("cold pin accepted existing WRITE handle");assert!(error.contains("INDEX_FILE_OPEN")&&error.contains("32"),"{error}");drop(writer);
    let error=tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).err().expect("cold pin accepted retained writable section/view");assert!(error.contains("INDEX_FILE_OPEN")&&error.contains("32"),"mapping live must fail closed, not rely on mtime: {error}");assert!(tantivy_engine::perf_cached_ready(&path).is_none());
    let time=fs::metadata(&target).unwrap().modified().unwrap();mapping.write_byte(original[0]^1);assert_ne!(fs::read(&target).unwrap(),original);println!("PERF_V2_MAPPING closed writer retained section/view; cold OS32; actual byte changed=true mtime_changed={}",fs::metadata(&target).unwrap().modified().unwrap()!=time);drop(mapping);
    assert!(tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).err().unwrap().contains("FILE_HASH_MISMATCH"));fs::write(&target,&original).unwrap();assert!(tantivy_engine::perf_open(&f.conn,&f.lib,s.generation).is_ok());
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(),b"needle mapping unchanged source");
}
#[test]
#[cfg(windows)]
fn perf_v2_cold_forget_barrier_miss_expired_no_late_insert_and_gc(){
    for expired in [false,true]{
        let f=Fixture::new();f.write("a.txt","needle epoch source");let s=f.build(Engine::Tantivy);f.search("needle");let path=tantivy_engine::location(&f.conn,&f.lib,s.generation).unwrap();
        let previous=if expired{let r=tantivy_engine::perf_cached_ready(&path).unwrap();tantivy_engine::perf_expire_cache(&path);Some(r)}else{tantivy_engine::forget(&f.conn,&f.lib,s.generation).unwrap();None};
        let db=f.work.join("test.db");let lib=f.lib.clone();let g=s.generation;let (reached_tx,reached_rx)=std::sync::mpsc::sync_channel(0);let (release_tx,release_rx)=std::sync::mpsc::sync_channel(0);
        let worker=std::thread::spawn(move||{let conn=Connection::open(db).unwrap();tantivy_engine::PERF_BEFORE_CACHE_INSERT.with(|h|*h.borrow_mut()=Some(Box::new(move||{reached_tx.send(()).unwrap();release_rx.recv_timeout(Duration::from_secs(30)).unwrap();})));tantivy_engine::perf_open(&conn,&lib,g).unwrap()});
        reached_rx.recv_timeout(Duration::from_secs(30)).unwrap();assert!(tantivy_engine::perf_cached_ready(&path).is_none());
        // The other connection's cold IO is complete and insertion is paused HERE.
        tantivy_engine::forget(&f.conn,&f.lib,g).unwrap();release_tx.send(()).unwrap();let ready=worker.join().unwrap();
        assert!(tantivy_engine::perf_cached_ready(&path).is_none(),"forget returned before cold insertion but cache resurrected");assert!(fs::remove_file(path.join("sealed.json")).is_err());drop(previous);
        let lease=acquire_lease(&f.conn,"v2-protected-reader",&f.lib,g).unwrap();let current=f.build(Engine::Tantivy);assert!(!gc_once(&f.conn,Some(&f.lib),&AtomicBool::new(false)).unwrap());
        drop(ready);release_lease("v2-protected-reader",&lease).unwrap();println!("PERF_V2_GC actual path={path:?} utf16len={}",path.to_string_lossy().encode_utf16().count());let gc=gc_background(&f.conn,&f.lib,&AtomicBool::new(false));if let Err(ref error)=gc{let cleanup:Option<String>=f.conn.query_row("SELECT cleanupPath FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![f.lib,g],|r|r.get(0)).unwrap();println!("PERF_V2_GC actual cleanup={cleanup:?} error={error}");}gc.unwrap();assert!(!path.exists());assert_eq!(f.search("needle").0[0].snapshot_generation,Some(current.generation));assert!(lock_runtime().unwrap().build.is_none());
        let retry=f.build(Engine::Tantivy);assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&retry.id).unwrap().phase,"completed");println!("PERF_V2_EPOCH expired={expired}: cold IO barrier -> cache-miss forget returned -> release -> absent; live Arc/lease protected; drop/release GC and retry ready");
    }
}
#[test]
#[cfg(windows)]
#[ignore="explicit v2 immutable read-only settled 64/256 probe; skipped is NOT passed"]
fn perf_v2_probe_known_settled_groups_three_samples(){
    let group=std::env::var("CR055_V2_GROUP").expect("explicit known group, not an arbitrary DB path");
    let (run,count,bytes,db_sha,manifest_sha,manifest_id)=match group.as_str(){
        "64mib"=>("after-64mib-tantivy",313i64,67216437i64,"e9a1b9b9e9805241b70b032d35106461d73a67f927911b7584ddc37847de24df","b0489d0cebf03479486b465d0cab47962910e8051441bf52185dbba8c9b0be78","37c16353ac93d7efb61bdf48ad6fad15320f7aeac48221fda0243150221e4772"),
        "256mib"=>("after-256mib-tantivy-retry02",1250i64,268436250i64,"c16368c819e6e7dfa395e7ab1752c19637140af1a3ce079f873ace716807fd9a","9ad1fb0c216cab1d0bfa015f45a38eae669be6769910e45ef687a47d5e88f230","639bbdac860f79a43a9eae1eb9dcc3fd3065c932392a1b8b72cbb3e35da242c5"),
        _=>panic!("unknown fixed group")
    };
    let work=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();let settled=work.parent().unwrap().join("performance-v1").join(run);let db=settled.join("snapshot.sqlite");let out=work.join("docs/Test").join(format!("PROBE-V2-{group}-01.json"));assert!(!out.exists());
    assert!(!PathBuf::from(format!("{}-wal",db.display())).exists());assert!(!PathBuf::from(format!("{}-shm",db.display())).exists());assert_eq!(format!("{:x}",Sha256::digest(fs::read(&db).unwrap())),db_sha);let before=perf_v1_tree_sha(&settled);
    let uri=format!("file:{}?mode=ro&immutable=1",db.to_string_lossy().replace('\\',"/"));let conn=Connection::open_with_flags(uri,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_URI).unwrap();conn.execute_batch("PRAGMA query_only=ON;").unwrap();let lib="formal-benchmark-library";let snap=active_snapshot(&conn,lib).unwrap().unwrap();
    let actual:(i64,i64)=conn.query_row("SELECT COUNT(*),SUM(CAST(sourceSize AS INTEGER)) FROM kb_snap_member WHERE libraryId=?1 AND generation=?2",params![lib,snap.generation],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(actual,(count,bytes));
    let source=PathBuf::from(performance::source_ref(&conn,lib).unwrap());let known_source=PathBuf::from("D:/github/AI_Delelovelop/docs/tmp/cr055-paired-20261122-0840/fixtures").join(&group).join("knowledge");assert_eq!(fs::canonicalize(&source).unwrap(),fs::canonicalize(&known_source).unwrap());let mf_path=source.parent().unwrap().join("manifest.json");let mf_bytes=fs::read(&mf_path).unwrap();assert_eq!(format!("{:x}",Sha256::digest(&mf_bytes)),manifest_sha);let manifest:serde_json::Value=serde_json::from_slice(&mf_bytes).unwrap();assert_eq!(manifest["manifestSha256"],manifest_id);assert_eq!(manifest["files"].as_array().unwrap().len(),count as usize);
    let start=Instant::now();let mut expected=HashMap::new();let mut raw_records=Vec::new();
    for e in manifest["files"].as_array().unwrap(){let relative=e["relative"].as_str().unwrap();let(size,sha):(String,String)=conn.query_row("SELECT sourceSize,sourceHash FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND relativeUri=?3",params![lib,snap.generation,relative],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(size.parse::<u64>().unwrap(),e["bytes"].as_u64().unwrap());assert_eq!(sha.strip_prefix("sha256:"),e["sha256"].as_str());let mut safe=files::SafeRoot::new(&source).unwrap();let raw=hash_reader(&mut files::open_snapshot(&mut safe,relative).unwrap(),&AtomicBool::new(false)).unwrap();safe.verify().unwrap();assert_eq!(raw.sha256,sha);assert_eq!(raw.bytes,e["bytes"].as_u64().unwrap());expected.insert(relative.to_string(),(raw.bytes,sha.clone()));raw_records.push(serde_json::json!({"relative":relative,"bytes":raw.bytes,"sha256":sha}));}
    let raw_seconds=start.elapsed().as_secs_f64();let start=Instant::now();let mut rebuilt:HashMap<String,(Sha256,u64,usize)>=HashMap::new();
    tantivy_engine::visit_primary(&conn,lib,snap.generation,|m,text|{assert_eq!(m.source_hash,expected[&m.relative_uri].1);assert_eq!(m.source_bytes.parse::<u64>().unwrap(),expected[&m.relative_uri].0);assert_eq!(m.generation,snap.generation);assert_eq!(m.library,lib);let e=rebuilt.entry(m.relative_uri.clone()).or_insert_with(||(Sha256::new(),0,0));assert_eq!(e.1,m.start);assert_eq!(e.2,m.ordinal);assert_eq!(m.end-m.start,text.len()as u64);e.0.update(text.as_bytes());e.1=m.end;e.2+=1;Ok(())}).unwrap();assert_eq!(rebuilt.len(),count as usize);
    let mut primary_records=Vec::new();for(relative,(sha,size,chunks))in rebuilt{let sha=format!("sha256:{:x}",sha.finalize());assert_eq!(expected[&relative],(size,sha.clone()));primary_records.push(serde_json::json!({"relative":relative,"bytes":size,"sha256":sha,"chunks":chunks}));}primary_records.sort_by_key(|v|v["relative"].as_str().unwrap().to_string());let primary_seconds=start.elapsed().as_secs_f64();
    let path=tantivy_engine::location(&conn,lib,snap.generation).unwrap();let seal:serde_json::Value=serde_json::from_slice(&fs::read(path.join("sealed.json")).unwrap()).unwrap();let batch_size=seal["files"].as_array().unwrap().len()+1;let mut queries=Vec::new();
    for(kind,needle)in [("common","baseline"),("rare","doc312"),("none","definitelyabsentzz123"),("cjk","中文索引"),("singleHan","中")]{
        let q=kb_index::parse_query(needle).unwrap();let mut samples=Vec::new();let mut human=Vec::new();let mut ai=Vec::new();let mut human_sha=None;let mut verified_stable=None;
        for sample in 0..3{
            tantivy_engine::CACHE_STATS.with(|s|*s.borrow_mut()=Default::default());let start=Instant::now();let(hits,incomplete)=search_library(&conn,lib,&q).unwrap().unwrap();let human_ms=start.elapsed().as_secs_f64()*1000.0;let hs=tantivy_engine::CACHE_STATS.with(|s|s.borrow().clone());
            let stable:Vec<_>=hits.iter().map(|h|serde_json::json!({"path":h.relative_uri,"ordinal":h.ordinal,"textSHA":format!("{:x}",Sha256::digest(h.chunk_text.as_bytes())),"score":h.score})).collect();let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&stable).unwrap()));if let Some(ref expected)=human_sha{assert_eq!(&hash,expected);}else{human_sha=Some(hash.clone());}
            tantivy_engine::CACHE_STATS.with(|s|*s.borrow_mut()=Default::default());let start=Instant::now();let gateway=verified::search(&conn,Some("benchmark-project"),needle).unwrap();let verified_ms=start.elapsed().as_secs_f64()*1000.0;let vs=tantivy_engine::CACHE_STATS.with(|s|s.borrow().clone());let vh=gateway["hits"].as_array().unwrap();assert!(vh.iter().all(|h|h["sourceVerified"]==true));let expected_counts=match kind{"common"=>(100,1),"rare"=>(1,1),"none"=>(0,0),"cjk"=>(100,5),"singleHan"=>(6,5),_=>unreachable!()};assert_eq!((hits.len(),vh.len()),expected_counts,"fixed corpus: human chunks and verified per-document/budget aggregation differ by design");for h in vh{let relative=h["relativeUri"].as_str().unwrap();assert_eq!(h["sourceHash"].as_str(),Some(expected[relative].1.as_str()));}
            let identities:Vec<_>=vh.iter().map(|h|serde_json::json!({"relativeUri":h["relativeUri"],"noteId":h["noteId"],"sourceHash":h["sourceHash"],"snippet":h["snippet"],"sourceVerified":h["sourceVerified"]})).collect();if let Some(ref expected)=verified_stable{assert_eq!(&identities,expected);}else{verified_stable=Some(identities);}
            assert_eq!(hs.cold_fullhashfiles,0,"warm human unexpectedly rebuilt Reader");assert_eq!(vs.cold_fullhashfiles,0,"warm verified unexpectedly rebuilt Reader");assert_eq!(hs.fresh_batch_files,hs.loads*batch_size as u64);assert_eq!(vs.fresh_batch_files,vs.loads*batch_size as u64);assert_eq!(hs.batch_ancestor_verifies,hs.loads*2);assert_eq!(vs.batch_ancestor_verifies,vs.loads*2);
            println!("PERF_V2_PROBE {group} {kind} sample={sample} human_ms={human_ms} verified_ms={verified_ms} actual_hits={} batch_size={batch_size}",hits.len());human.push(human_ms);ai.push(verified_ms);samples.push(serde_json::json!({"sample":sample,"humanMs":human_ms,"verifiedMs":verified_ms,"humanHits":hits.len(),"verifiedHits":vh.len(),"humanIncomplete":incomplete,"verifiedIncomplete":gateway["incomplete"],"humanOutputSHA":hash,"humanStats":hs,"verifiedStats":vs,"gateway":gateway}));
        }
        human.sort_by(|a,b|a.partial_cmp(b).unwrap());ai.sort_by(|a,b|a.partial_cmp(b).unwrap());queries.push(serde_json::json!({"kind":kind,"needle":needle,"samples":samples,"sampleCount":3,"medianHumanMs":human[1],"medianVerifiedMs":ai[1]}));
    }
    tantivy_engine::forget(&conn,lib,snap.generation).unwrap();drop(conn);let after=perf_v1_tree_sha(&settled);assert_eq!(after,before,"read-only probe changed settled index/DB files");assert!(!PathBuf::from(format!("{}-wal",db.display())).exists());assert!(!PathBuf::from(format!("{}-shm",db.display())).exists());assert_eq!(fs::read(&mf_path).unwrap(),mf_bytes);
    let report=serde_json::json!({"group":group,"db":db,"dbSHA256":db_sha,"sourceFiles":count,"sourceBytes":bytes,"manifestFileSHA256":manifest_sha,"manifestIdentity":manifest_id,"fullOriginalShaValidated":true,"fullPrimaryShaValidated":true,"metaSourceHashMatchesSqlOriginal":true,"rawValidationSeconds":raw_seconds,"fullPrimaryValidationSeconds":primary_seconds,"rawRecords":raw_records,"primaryRecords":primary_records,"readOnlyFilesUnchanged":true,"settledBefore":before,"settledAfter":after,"walShmAbsent":true,"batchFilesPerLogicalOpen":batch_size,"osCold":false,"isP95":false,"fullBuildRun":false,"queries":queries,"semantics":"actual unchanged human search_library and verified::search; full source SHA and final authorization fence retained"});let mut file=fs::OpenOptions::new().write(true).create_new(true).open(out).unwrap();use std::io::Write;file.write_all(&serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
#[test]
fn formal_small_io_fault_matrix_keeps_old_active_and_releases_reservation(){
    use tantivy_engine::io_faults::{self,Fault};
    for mode in [Fault::Enospc,Fault::Permission,Fault::Write,Fault::Flush,Fault::Terminate,Fault::ReadMissing,Fault::AtomicRead,Fault::AtomicWrite,Fault::Sync,Fault::WorkerExit,Fault::WorkerTokenPanic]{
        let f=Fixture::new();let body="old needle full source proof\r\n".repeat(700);f.write("a.txt",&body);
        let source_sha=Sha256::digest(body.as_bytes());let old=f.build(Engine::Sqlite);let spec=f.spec(Engine::Tantivy);
        let cancel=Arc::new(AtomicBool::new(false));
        {let mut rt=lock_runtime().unwrap();assert!(rt.build.is_none());rt.build=Some(ActiveBuild{owner:"formal-owner".into(),library:f.lib.clone(),id:spec.id.clone(),cancel:cancel.clone()});}
        let injection=io_faults::arm(mode);
        // Same production build + terminal + reservation components, without application DB/IPC.
        // This is not a test of the async Tauri command or the real application worker launcher.
        let result={
            let _reservation=BuildReservation{cancel:cancel.clone()};
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(||build_snapshot(&f.conn,&spec,&cancel,&Fixture::limits())))
                .unwrap_or_else(|_|Err("INDEX_WORKER_PANIC: 后台构建异常退出，旧快照保留".into()))
        };
        let fired=injection.fired();drop(injection);assert!(fired,"unreached injection {mode:?}");
        let error=result.expect_err(&format!("fault must not silently publish {mode:?}"));
        assert!(!error.contains("root_io="),"must not invent a root cause: {error}");
        if mode!=Fault::WorkerExit{assert!(error.contains("observed_io="),"{mode:?}: {error}");}
        terminal(&f.conn,&spec,"failed",&error).unwrap();
        let task=task_row(&f.conn,"formal-owner",&f.lib,&spec.id).unwrap();assert_eq!(task.phase,"failed");
        assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
        assert_eq!(f.conn.query_row("SELECT state FROM kb_snap_generation WHERE id=?1",[spec.generation],|r|r.get::<_,String>(0)).unwrap(),"failed");
        assert!(!tantivy_engine::location(&f.conn,&f.lib,spec.generation).unwrap().join("sealed.json").exists());
        assert_eq!(Sha256::digest(fs::read(f.root.join("a.txt")).unwrap()),source_sha);
        assert!(lock_runtime().unwrap().build.is_none(),"reservation leaked {mode:?}");
        assert_eq!(f.search("needle").0[0].snapshot_generation,Some(old.generation));
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        let retry=f.build(Engine::Tantivy);assert_eq!(task_row(&f.conn,"formal-owner",&f.lib,&retry.id).unwrap().phase,"completed");
        assert_eq!(f.search("needle").0[0].snapshot_generation,Some(retry.generation));
        println!("fault={mode:?}; failed_generation={}; old_active={}; retry_generation={}; source_sha={:x}; slot_released=true; error={error}",spec.generation,old.generation,retry.generation,source_sha);
    }
}
