//! Explicitly invoked fixed-corpus harness; both engines use the formal host build and verified gateway.
use super::*;
use super::super::verified;
struct EngineErrorLog;
impl log::Log for EngineErrorLog {
    fn enabled(&self,m:&log::Metadata)->bool{m.target().starts_with("tantivy")&&m.level()<=log::Level::Warn}
    fn log(&self,r:&log::Record){if self.enabled(r.metadata()){eprintln!("[engine-diagnostic] {} {}: {}",r.level(),r.target(),r.args());}}
    fn flush(&self){}
}
static ENGINE_LOG:EngineErrorLog=EngineErrorLog;
#[test]
#[ignore = "explicit fixed-corpus measurement only; ignored is not a passed benchmark"]
fn formal_paired_fixed_corpus(){
    log::set_logger(&ENGINE_LOG).expect("isolated measurement logger");log::set_max_level(log::LevelFilter::Warn);
    let root=PathBuf::from(std::env::var_os("CR055_FORMAL_FIXTURE").expect("fixture directory"));
    let work=PathBuf::from(std::env::var_os("CR055_FORMAL_RUN").expect("new empty run directory"));
    let engine=match std::env::var("CR055_FORMAL_ENGINE").unwrap().as_str(){"sqlite"=>Engine::Sqlite,"tantivy"=>Engine::Tantivy,_=>panic!("engine")};
    let manifest_bytes=fs::read(root.join("manifest.json")).unwrap();let manifest:serde_json::Value=serde_json::from_slice(&manifest_bytes).unwrap();
    let entries=manifest["files"].as_array().unwrap();assert!(entries.len()==313||entries.len()==1250);
    let source=fs::canonicalize(root.join("knowledge")).unwrap();assert!(!work.exists(),"never overwrite prior measurements");
    let total_start=Instant::now();fs::create_dir_all(&work).unwrap();let db=work.join("snapshot.sqlite");let conn=Connection::open(&db).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceRef TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,sourceKind TEXT NOT NULL DEFAULT 'managed-directory');CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT);CREATE INDEX legacy_lookup ON knowledge_note_index(libraryId,relativeUri);CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,revision INTEGER,PRIMARY KEY(projectId,libraryId));").unwrap();
    let lib="formal-benchmark-library";conn.execute("INSERT INTO knowledge_library(id,name,sourceRef) VALUES(?1,'fixture',?2)",params![lib,source.to_string_lossy()]).unwrap();
    performance::migrate(&conn).unwrap();migrate(&conn).unwrap();conn.execute("INSERT INTO project_library_grant VALUES('benchmark-project',?1,1,1)",[lib]).unwrap();
    STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());let before_generation=Instant::now();let spec=begin_build_engine(&conn,"benchmark-owner",lib,"benchmark-request",engine).unwrap();let generation_seconds=before_generation.elapsed().as_secs_f64();
    let setup_seconds=total_start.elapsed().as_secs_f64();let build_start=Instant::now();
    let outcome=build_snapshot(&conn,&spec,&AtomicBool::new(false),&Limits::default());let build_seconds=build_start.elapsed().as_secs_f64();let pipeline_seconds=total_start.elapsed().as_secs_f64();
    sample_wal(&conn);let task=task_row(&conn,"benchmark-owner",lib,&spec.id).unwrap();assert!(outcome.is_ok(),"{outcome:?}");assert_eq!(task.phase,"completed");assert_eq!(active_snapshot(&conn,lib).unwrap().unwrap().generation,spec.generation);
    let(members,bytes):(i64,i64)=conn.query_row("SELECT COUNT(*),SUM(CAST(sourceSize AS INTEGER)) FROM kb_snap_member WHERE generation=?1",[spec.generation],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(manifest["sourceFiles"].as_i64(),Some(members));assert_eq!(manifest["sourceBytes"].as_i64(),Some(bytes));
    let check_start=Instant::now();let mut expected=HashMap::new();let mut original_aggregate=Sha256::new();
    for e in entries{
        let path=e["relative"].as_str().unwrap();let(size,sha):(String,String)=conn.query_row("SELECT sourceSize,sourceHash FROM kb_snap_member WHERE generation=?1 AND relativeUri=?2",params![spec.generation,path],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(size.parse::<u64>().unwrap(),e["bytes"].as_u64().unwrap());assert_eq!(sha.strip_prefix("sha256:"),e["sha256"].as_str());
        let mut safe=files::SafeRoot::new(&source).unwrap();let mut raw=files::open_snapshot(&mut safe,path).unwrap();let raw_hash=hash_reader(&mut raw,&AtomicBool::new(false)).unwrap();safe.verify().unwrap();assert_eq!(raw_hash.sha256,sha,"complete raw source {path}");assert_eq!(raw_hash.bytes,size.parse::<u64>().unwrap());
        expected.insert(path.to_string(),(size.parse::<u64>().unwrap(),sha));original_aggregate.update(path.as_bytes());original_aggregate.update(e["sha256"].as_str().unwrap().as_bytes());
    }
    let mut rebuilt:HashMap<String,(Sha256,u64,usize)>=HashMap::new();
    let mut emit=|path:&str,ordinal:usize,start:u64,end:u64,text:&str|->Result<(),String>{
        let e=rebuilt.entry(path.into()).or_insert_with(||(Sha256::new(),0,0));if e.1!=start||end-start!=text.len() as u64||e.2!=ordinal{return Err("RECONSTRUCTION_CONTINUITY".into());}e.0.update(text.as_bytes());e.1=end;e.2+=1;Ok(())
    };
    if engine==Engine::Tantivy{tantivy_engine::visit_primary(&conn,lib,spec.generation,|m,t|emit(&m.relative_uri,m.ordinal,m.start,m.end,t)).unwrap();}
    else{let _lease=ReadLease::new(&conn,lib,spec.generation).unwrap();let mut stmt=conn.prepare("SELECT m.relativeUri,c.chunkKey,c.ordinal,c.startByte,c.endByte,c.text FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 ORDER BY m.noteId,c.ordinal").unwrap();let mut rows=stmt.query(params![lib,spec.generation]).unwrap();while let Some(r)=rows.next().unwrap(){let text=piece_text(&conn,lib,spec.generation,r.get(1).unwrap(),false,Some(r.get(5).unwrap())).unwrap();emit(&r.get::<_,String>(0).unwrap(),r.get::<_,i64>(2).unwrap() as usize,r.get::<_,i64>(3).unwrap() as u64,r.get::<_,i64>(4).unwrap() as u64,&text).unwrap();}}
    assert_eq!(rebuilt.len(),expected.len());let mut primary_hashes=Vec::new();
    for(path,(sha,size,count))in rebuilt{let hash=format!("sha256:{:x}",sha.finalize());assert_eq!(expected.get(&path),Some(&(size,hash.clone())),"full UTF8 primary reconstruction {path}");primary_hashes.push(serde_json::json!({"relative":path,"bytes":size,"sha256":hash,"chunks":count}));}
    primary_hashes.sort_by_key(|v|v["relative"].as_str().unwrap().to_string());fs::write(work.join("primary-sha.json"),serde_json::to_vec_pretty(&primary_hashes).unwrap()).unwrap();
    let reconstruction_seconds=check_start.elapsed().as_secs_f64();let mut queries=Vec::new();
    for(kind,needle) in [("common","baseline"),("rare","doc312"),("none","definitelyabsentzz123"),("cjk","中文索引"),("singleHan","中")]{
        let q=kb_index::parse_query(needle).unwrap();let t=Instant::now();let(hits,incomplete)=search_library(&conn,lib,&q).unwrap().unwrap();let human_ms=t.elapsed().as_secs_f64()*1000.0;
        let stable:Vec<_>=hits.iter().map(|h|serde_json::json!({"path":h.relative_uri,"ordinal":h.ordinal,"textSHA":format!("{:x}",Sha256::digest(h.chunk_text.as_bytes())),"score":h.score})).collect();
        let t=Instant::now();let gateway=verified::search(&conn,Some("benchmark-project"),needle).unwrap();let verified_ms=t.elapsed().as_secs_f64()*1000.0;fs::write(work.join(format!("{kind}-verified.json")),serde_json::to_vec_pretty(&gateway).unwrap()).unwrap();
        queries.push(serde_json::json!({"kind":kind,"needle":needle,"humanMs":human_ms,"humanHits":hits.len(),"humanIncomplete":incomplete,"humanOutputSHA":format!("{:x}",Sha256::digest(serde_json::to_vec(&stable).unwrap())),"verifiedMs":verified_ms,"verifiedHits":gateway["hits"].as_array().unwrap().len(),"verifiedIncomplete":gateway["incomplete"],"verifiedOutputSHA":format!("{:x}",Sha256::digest(serde_json::to_vec(&gateway).unwrap()))}));
    }
    let path=entries[0]["relative"].as_str().unwrap();let note:String=conn.query_row("SELECT noteId FROM kb_snap_member WHERE generation=?1 AND relativeUri=?2",params![spec.generation,path],|r|r.get(0)).unwrap();let read_start=Instant::now();let(view,proof,_)=verified::read(&conn,Some("benchmark-project"),lib,Some(&note),None,Some(37)).unwrap();let read_ms=read_start.elapsed().as_secs_f64()*1000.0;assert_eq!(view.content.len(),37);assert_eq!(view.source_hash,expected[path].1);let raw_prefix=fs::read(source.join(path)).unwrap();assert_eq!(view.content.as_bytes(),&raw_prefix[..37]);drop(proof);
    let file_bytes=|suffix:&str|fs::metadata(format!("{}{suffix}",db.display())).map(|m|m.len()).unwrap_or(0);
    let db_bytes=file_bytes("");let wal_bytes=file_bytes("-wal");let shm_bytes=file_bytes("-shm");let index_bytes=directory_bytes(&tantivy_engine::managed_root(&conn).unwrap()).unwrap();
    let(stages,wal_peak)=STAGE_STATS.with(|s|{let s=s.borrow();(s.elapsed.map(|d|d.as_secs_f64()),s.wal_sampled_peak)});let names=["hash","parse","insertBatches","sourceValidation","sqliteOptimize","publish","copyParse","engineCommitDrain","engineStoreValidation","engineSealSync"];
    let phase_seconds:serde_json::Map<String,serde_json::Value>=names.iter().zip(stages).map(|(n,t)|(n.to_string(),serde_json::json!(t))).collect();
    let(decode_calls,reused_files)=STAGE_STATS.with(|s|{let s=s.borrow();(s.decode_calls,s.reused_files)});
    assert_eq!(decode_calls,members as u64,"initial all-text corpus must really decode every source");assert_eq!(reused_files,0,"new fixture has no prior generation to reuse");
    let checkpoint:(i64,i64,i64)=conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();assert_eq!(checkpoint.0,0);
    let mut report=serde_json::json!({"kind":"formal-host-fixed-corpus","engine":format!("{engine:?}"),"source":source,"sourceFiles":members,"sourceBytes":bytes,"sourceManifestIdentity":manifest["manifestSha256"],"manifestFileSHA":format!("{:x}",Sha256::digest(&manifest_bytes)),"sourceAggregateSHA":format!("{:x}",original_aggregate.finalize()),"setupSeconds":setup_seconds,"createGenerationSeconds":generation_seconds,"hostBuildSeconds":build_seconds,"pipelineSeconds":pipeline_seconds,"phaseSeconds":phase_seconds,"phaseTiming":"thread-local exclusive host timers; commit includes wait/merge; no OS cold claim","fullPrimaryValidated":true,"fullPrimaryValidationSeconds":reconstruction_seconds,"queryChecks":queries,"verifiedReadMs":read_ms,"verifiedReadSHA":format!("{:x}",Sha256::digest(serde_json::to_vec(&view).unwrap())),"dbBytes":db_bytes,"walBytes":wal_bytes,"shmBytes":shm_bytes,"indexBytes":index_bytes,"totalBeforeCheckpointBytes":db_bytes+wal_bytes+shm_bytes+index_bytes,"walSampledPeakBytes":wal_peak,"checkpoint":{"busy":checkpoint.0,"frames":checkpoint.1,"checkpointed":checkpoint.2},"afterCheckpointDbBytes":file_bytes(""),"afterCheckpointWalBytes":file_bytes("-wal"),"afterCheckpointShmBytes":file_bytes("-shm"),"afterCheckpointTotalBytes":file_bytes("")+file_bytes("-wal")+file_bytes("-shm")+index_bytes,"synchronous":conn.query_row("PRAGMA synchronous",[],|r|r.get::<_,i64>(0)).unwrap(),"writerBudgetBytes":if engine==Engine::Tantivy{Some(tantivy_engine::WRITER_BYTES)}else{None},"osCold":false,"sourceVerified":true,"privateMemoryMeasuredByExternalHarness":false,"retiredGenerationBytes":0,"temporaryGenerationBytes":0,"success":true});
    report["sourceProof"]=serde_json::json!({"rawOriginalValidatedFiles":members,"actualDecodeCalls":decode_calls,"reusedFiles":reused_files,"reuseScope":"initial full build; unchanged=0/one-changed=1 demonstrated by focused real-pipeline regressions, not this initial build","verifiedReadSourceSHA":view.source_hash,"verifiedReadContentSHA":format!("{:x}",Sha256::digest(view.content.as_bytes())),"verifiedReadContentMatchesRawPrefix":true});
    fs::write(work.join("report.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();println!("{report}");
    tantivy_engine::forget(&conn,lib,spec.generation).unwrap();
}
