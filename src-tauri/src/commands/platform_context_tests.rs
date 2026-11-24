use super::*;

fn conn() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE session(id TEXT PRIMARY KEY,projectId TEXT,featureId TEXT,featureSourceHash TEXT,sessionRole TEXT NOT NULL DEFAULT 'ordinary');
        CREATE TABLE message(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,role TEXT,content TEXT,metaJson TEXT,refsJson TEXT,createdAt INTEGER);
        CREATE TABLE project(id TEXT PRIMARY KEY,rootUri TEXT);
        CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,sourceRef TEXT,revision INTEGER,enabled INTEGER);
        CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,revision INTEGER,readAllowed INTEGER);
        CREATE TABLE capability(id TEXT,kind TEXT,name TEXT,enabled INTEGER,sourceRef TEXT);
        INSERT INTO session(id) VALUES('s'),('other');").unwrap();
    migrate(&c).unwrap();
    c
}

fn scope() -> ScopeStamp { ScopeStamp { session_id:"s".into(),project_id:None,value:"scope".into() } }

fn insert(c: &Connection, id: &str, role: &str, text: &str, meta: Option<Value>, refs: Option<Value>) {
    c.execute("INSERT INTO message(id,sessionId,role,content,metaJson,refsJson,createdAt) VALUES(?1,'s',?2,?3,?4,?5,1)",
        params![id,role,text,meta.map(|v| v.to_string()),refs.map(|v| v.to_string())]).unwrap();
}

fn session() -> SessionMeta {
    serde_json::from_value(json!({"id":"s","projectId":null,"serverId":null,"title":"t","cliId":null,"providerId":null,
        "modelId":null,"effort":null,"draft":"draft","unread":null,"createdAt":1,"updatedAt":1,"messageCount":0})).unwrap()
}

#[test]
fn migration_is_additive_idempotent_and_cascades() {
    let c = conn();
    insert(&c,"u","user","unchanged",None,None);
    migrate(&c).unwrap();
    assert_eq!(c.query_row("SELECT content FROM message WHERE id='u'",[],|r| r.get::<_,String>(0)).unwrap(),"unchanged");
    save_transcript(&c,&scope(),"u",&[ChatMsg::Assistant{text:"reply".into(),tool_calls:vec![]}]).unwrap();
    c.execute("INSERT INTO session_context_state VALUES('s',0,1)",[]).unwrap();
    c.execute("DELETE FROM session WHERE id='s'",[]).unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM session_context_turn",[],|r| r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM session_context_state",[],|r| r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn transcript_preserves_multiple_tool_exchanges() {
    let c = conn();
    insert(&c,"u","user","question",None,None);
    let messages = vec![
        ChatMsg::Assistant{text:"first".into(),tool_calls:vec![ToolCall{id:"c1".into(),name:"get_context".into(),arguments:"{}".into()}]},
        ChatMsg::Tool{call_id:"c1".into(),content:"r1".into(),is_error:false},
        ChatMsg::Assistant{text:"second".into(),tool_calls:vec![ToolCall{id:"c2".into(),name:"list_projects".into(),arguments:"{}".into()}]},
        ChatMsg::Tool{call_id:"c2".into(),content:"r2".into(),is_error:false},
        ChatMsg::Assistant{text:"final".into(),tool_calls:vec![]},
    ];
    save_transcript(&c,&scope(),"u",&messages).unwrap();
    let history = load_history(&c,&scope()).unwrap();
    assert_eq!(serde_json::to_value(&history[0].messages[1..]).unwrap(),serde_json::to_value(messages).unwrap());
    assert_eq!(history[0].ids(),vec!["u"]);
}

#[test]
fn legacy_history_pairs_calls_and_does_not_invent_results() {
    let c = conn();
    insert(&c,"u","user","q",None,None);
    insert(&c,"a","assistant","answer",None,None);
    insert(&c,"c","tool_use","get_context",Some(json!({"toolId":"c1","input":"{}"})),None);
    insert(&c,"r","tool_result","result",Some(json!({"toolId":"c1","isError":false})),None);
    let turns = load_history(&c,&scope()).unwrap();
    validate_pairs(&turns[0].messages).unwrap();
    assert!(matches!(turns[0].messages.last(),Some(ChatMsg::Tool {call_id,..}) if call_id=="c1"));
    c.execute("DELETE FROM message WHERE id='r'",[]).unwrap();
    assert!(load_history(&c,&scope()).is_err());
}

#[test]
fn tool_pairs_reject_orphans_duplicates_and_unfinished_calls() {
    assert!(validate_pairs(&[ChatMsg::Tool{call_id:"x".into(),content:"r".into(),is_error:false}]).is_err());
    let call = ToolCall{id:"x".into(),name:"tool".into(),arguments:"{}".into()};
    assert!(validate_pairs(&[ChatMsg::Assistant{text:"".into(),tool_calls:vec![call.clone()]}]).is_err());
    assert!(validate_pairs(&[ChatMsg::Assistant{text:"".into(),tool_calls:vec![call.clone(),call]}]).is_err());
}

#[test]
fn budget_counts_system_schema_tools_and_actual_output() {
    let b = ContextBudget::from_model(Some(2000),Some(500));
    let body = json!({"model":"m","system":"s","messages":[],"tools":[{"description":"x".repeat(900)}],"max_tokens":400});
    b.check(&body).unwrap();
    let mut bigger = body.clone();
    bigger["messages"] = json!([{"role":"tool","content":"x".repeat(1000)}]);
    assert!(b.check(&bigger).unwrap_err().contains("BUDGET"));
    bigger["max_tokens"] = json!(501);
    assert!(b.check(&bigger).unwrap_err().contains("OUTPUT"));
}

#[test]
fn unknown_window_is_explicit_and_reasoning_reserve_is_counted() {
    let b = ContextBudget::from_model(None,None);
    assert!(b.unknown);
    assert_eq!(b.window,32768);
    assert_eq!(ContextBudget::output(&json!({"max_completion_tokens":128})),128);
    let b = ContextBudget::from_model(Some(16000),None);
    assert!(b.check(&json!({"thinking":{"budget_tokens":16384},"max_tokens":20480})).is_err());
}

#[test]
fn source_hash_binds_ids_content_refs_and_replay() {
    let c = conn();
    insert(&c,"u","user","q",None,None);
    let turns = load_history(&c,&scope()).unwrap();
    let first = source_hash(&turns,&["u".into()]).unwrap();
    let mut changed = turns.clone();
    changed[0].source[0].refs_json = Some("[]".into());
    assert_ne!(first,source_hash(&changed,&["u".into()]).unwrap());
    assert!(source_hash(&turns,&["other-message".into()]).is_err());
    assert!(source_hash(&turns,&["u".into(),"u".into()]).is_err());
}

#[test]
fn scope_changes_on_revocation_revision_skill_and_project() {
    let c = conn();
    let s = session();
    let before = scope_stamp(&c,&s).unwrap();
    c.execute("INSERT INTO knowledge_library VALUES('k','/kb',1,1)",[]).unwrap();
    let library = scope_stamp(&c,&s).unwrap();
    assert_ne!(before.value,library.value);
    c.execute("UPDATE knowledge_library SET enabled=0",[]).unwrap();
    assert_ne!(library.value,scope_stamp(&c,&s).unwrap().value);
    c.execute("INSERT INTO capability VALUES('sk','skill','test',1,'/skill')",[]).unwrap();
    let skill = scope_stamp(&c,&s).unwrap();
    c.execute("UPDATE capability SET enabled=0",[]).unwrap();
    assert_ne!(skill.value,scope_stamp(&c,&s).unwrap().value);
    c.execute("UPDATE session SET projectId='foreign' WHERE id='s'",[]).unwrap();
    assert!(scope_stamp(&c,&s).is_err());
}

#[test]
fn changed_authority_and_unknown_legacy_sources_fail_closed() {
    let c = conn();
    insert(&c,"u","user","q",None,None);
    save_transcript(&c,&scope(),"u",&[ChatMsg::Assistant{text:"sensitive".into(),tool_calls:vec![]}]).unwrap();
    let changed = ScopeStamp {value:"revoked".into(),..scope()};
    assert!(load_history(&c,&changed).is_err());
    c.execute("DELETE FROM session_context_turn",[]).unwrap();
    insert(&c,"f","tool_use","fs_read",Some(json!({"toolId":"f1","input":{"path":"secret"}})),None);
    assert!(load_history(&c,&scope()).is_err());
}

#[test]
fn summary_is_structured_bounded_and_not_an_authorization() {
    let raw = json!({"goal":"task","constraints":["do not write code"],"decisions":[],"progress":[],"evidence":["test failed"],"unresolved":["not approved"]});
    let summary = Summary::parse(&raw.to_string()).unwrap();
    assert!(summary.text().contains("not approved"));
    assert!(Summary::parse("{}").is_err());
    assert!(Summary::parse(&"x".repeat(MAX_SUMMARY_BYTES+1)).is_err());
    let mut bad = raw;
    bad["authorized"] = json!(true);
    assert!(Summary::parse(&bad.to_string()).is_err());
}

fn history_fixture(c: &Connection, count: usize) -> (ScopeStamp,Vec<HistoryTurn>) {
    let stamp = scope_stamp(c,&session()).unwrap();
    for i in 0..count {
        insert(c,&format!("u{i}"),"user",&format!("不要删除原文；失败证据还未验收。{}", "上下文资料".repeat(80)),None,None);
        insert(c,&format!("a{i}"),"assistant",&format!("第{i}轮测试失败，下一步修复。{}", "历史证据".repeat(80)),None,None);
    }
    let history = load_history(c,&stamp).unwrap();
    (stamp,history)
}

fn small_summary() -> Summary {
    Summary { goal:"继续修复".into(),constraints:vec!["不要删除原文".into()],decisions:vec![],
        progress:vec!["已核对源码".into()],evidence:vec!["测试失败".into()],unresolved:vec!["尚未验收".into()] }
}

#[test]
fn compression_protects_recent_complete_turns_and_current_prompt() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let candidate = next_candidate(&history,&[]).unwrap();
    assert!(candidate.source_ids.contains(&"u0".into()));
    assert!(!candidate.source_ids.contains(&"u5".into()));
    assert!(candidate_range(&history,&[],"u4","u5").is_err());
    let block = make_block(&candidate,small_summary(),&stamp,"m").unwrap();
    let messages = project(&history,&[block],"system rules","latest question");
    assert!(matches!(messages.first(),Some(ChatMsg::System(s)) if s=="system rules"));
    assert!(matches!(messages.last(),Some(ChatMsg::User(s)) if s=="latest question"));
    for i in 5..9 { assert!(messages.iter().any(|m| matches!(m,ChatMsg::User(s) if s==&history[i].source[0].content))); }
}

#[test]
fn summary_commit_is_atomic_cas_and_does_not_mutate_original_messages() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let before: String = c.query_row("SELECT GROUP_CONCAT(id||content) FROM message",[],|r| r.get(0)).unwrap();
    let block = make_block(&next_candidate(&history,&[]).unwrap(),small_summary(),&stamp,"m").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    assert_eq!(apply_blocks(&tx,&session(),&stamp,0,&[block.clone()],&[block.clone()]).unwrap(),1);
    tx.commit().unwrap();
    let (revision,loaded) = load_blocks(&c,&stamp,&history).unwrap();
    assert_eq!(revision,1);
    assert_eq!(loaded[0].id,block.id);
    let tx = c.unchecked_transaction().unwrap();
    assert!(apply_blocks(&tx,&session(),&stamp,0,&[block.clone()],&[block]).is_err());
    drop(tx);
    assert_eq!(c.query_row("SELECT GROUP_CONCAT(id||content) FROM message",[],|r| r.get::<_,String>(0)).unwrap(),before);
}

#[test]
fn sql_failure_rolls_back_revision_and_blocks() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let block = make_block(&next_candidate(&history,&[]).unwrap(),small_summary(),&stamp,"m").unwrap();
    c.execute_batch("CREATE TRIGGER reject_context BEFORE INSERT ON session_context_block BEGIN SELECT RAISE(ABORT,'injected SQL failure'); END;").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    assert!(apply_blocks(&tx,&session(),&stamp,0,&[block.clone()],&[block]).is_err());
    drop(tx);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM session_context_state",[],|r| r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM session_context_block",[],|r| r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn partial_foreign_or_overlapping_ranges_cannot_be_committed() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let block = make_block(&next_candidate(&history,&[]).unwrap(),small_summary(),&stamp,"m").unwrap();
    let mut partial = block.clone();
    partial.source_ids.pop();
    partial.source_hash = source_hash(&history,&partial.source_ids).unwrap();
    let tx = c.unchecked_transaction().unwrap();
    assert!(apply_blocks(&tx,&session(),&stamp,0,&[partial.clone()],&[partial]).is_err());
    drop(tx);
    let tx = c.unchecked_transaction().unwrap();
    assert!(apply_blocks(&tx,&session(),&stamp,0,&[block.clone(),block.clone()],&[block]).is_err());
}

#[test]
fn layered_merge_keeps_parent_sources_and_superseded_receipts() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,14);
    let first = make_block(&candidate_range(&history,&[],"u0","u3").unwrap(),small_summary(),&stamp,"m").unwrap();
    let second = make_block(&candidate_range(&history,&[],"u4","u7").unwrap(),small_summary(),&stamp,"m").unwrap();
    let parents = vec![first.clone(),second.clone()];
    let candidate = candidate_range(&history,&parents,"u0","u7").unwrap();
    assert_eq!(candidate.level,2);
    assert_eq!(candidate.parent_ids,vec![first.id.clone(),second.id.clone()]);
    let parent = make_block(&candidate,small_summary(),&stamp,"m").unwrap();
    assert_eq!(parent.source_ids.len(),16);
    let tx = c.unchecked_transaction().unwrap();
    apply_blocks(&tx,&session(),&stamp,0,&[parent.clone()],&[first,second,parent.clone()]).unwrap();
    tx.commit().unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM session_context_block WHERE status='superseded'",[],|r| r.get::<_,i64>(0)).unwrap(),2);
    let (rev,blocks) = load_blocks(&c,&stamp,&history).unwrap();
    assert_eq!(rev,1);
    assert_eq!(blocks.len(),1);
    assert_eq!(blocks[0].id,parent.id);
    assert!(read_context(&history,&blocks,&parent.id,0,4096).unwrap()["content"].as_str().unwrap().contains("不要删除原文"));
}

#[test]
fn level_three_is_a_ceiling_and_merged_blocks_cannot_be_split() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,14);
    let mut first = make_block(&candidate_range(&history,&[],"u0","u3").unwrap(),small_summary(),&stamp,"m").unwrap();
    first.level = 3;
    let second = make_block(&candidate_range(&history,&[],"u4","u7").unwrap(),small_summary(),&stamp,"m").unwrap();
    let blocks = vec![first,second];
    assert_eq!(candidate_range(&history,&blocks,"u0","u7").unwrap().level,3);
    assert!(candidate_range(&history,&blocks,"u0","u2").is_err());
}

#[test]
fn no_shrink_and_oversized_summary_are_rejected() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let mut candidate = next_candidate(&history,&[]).unwrap();
    candidate.before_bytes=10;
    assert!(make_block(&candidate,small_summary(),&stamp,"m").is_err());
}

#[test]
fn original_pages_are_utf8_safe_bounded_and_cross_session_rejected() {
    let c = conn();
    let (_,history) = history_fixture(&c,9);
    let page = read_context(&history,&[],"u0",1,12).unwrap();
    assert_eq!(page["offset"],json!(0));
    assert!(page["content"].as_str().unwrap().len()<=12);
    assert!(page["untrusted"].as_bool().unwrap());
    assert!(read_context(&history,&[],"foreign-message",0,4096).is_err());
    assert!(read_context(&history,&[],"../../secrets.json",0,4096).is_err());
    assert!(byte_page("中文😀",0,MAX_PAGE_BYTES+1).is_err());
    assert!(byte_page("中文😀",100,4).is_err());
    let p = byte_page("中文😀",0,6).unwrap();
    assert_eq!(p["content"],json!("中文"));
    assert_eq!(p["nextOffset"],json!(6));
    assert_eq!(byte_page("中文😀",6,4).unwrap()["nextOffset"],Value::Null);
}

#[test]
fn search_is_bounded_and_returns_stable_source_ids() {
    let c = conn();
    let (_,history) = history_fixture(&c,30);
    let result = search_context(&history,&[],"失败").unwrap();
    assert!(result["hits"].as_array().unwrap().len()<=10);
    assert!(result.to_string().len()<=4096);
    assert_eq!(result["hits"][0]["id"],json!("u0"));
    assert!(search_context(&history,&[],"").is_err());
    assert!(search_context(&history,&[],&"x".repeat(257)).is_err());
}

#[test]
fn restored_state_revalidates_content_and_current_authority() {
    let c = conn();
    let (stamp,history) = history_fixture(&c,9);
    let block = make_block(&next_candidate(&history,&[]).unwrap(),small_summary(),&stamp,"m").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    apply_blocks(&tx,&session(),&stamp,0,&[block.clone()],&[block]).unwrap();
    tx.commit().unwrap();
    assert!(load_blocks(&c,&stamp,&load_history(&c,&stamp).unwrap()).is_ok());
    c.execute("UPDATE message SET content='edited' WHERE id='u0'",[]).unwrap();
    assert!(load_blocks(&c,&stamp,&load_history(&c,&stamp).unwrap()).is_err());
    c.execute("INSERT INTO knowledge_library VALUES('k','kb',1,1)",[]).unwrap();
    let new_scope=scope_stamp(&c,&session()).unwrap();
    assert!(load_blocks(&c,&new_scope,&history).is_err());
}

#[test]
fn context_tool_definitions_are_fixed_and_have_no_business_powers() {
    let tools=tool_defs();
    assert_eq!(tools.len(),4);
    for d in tools { assert!(CONTEXT_TOOLS.contains(&d.name)); assert_eq!(d.schema["additionalProperties"],json!(false)); }
    assert!(!CONTEXT_TOOLS.contains(&"ssh_exec"));
    assert!(!CONTEXT_TOOLS.contains(&"dispatch_once"));
}

#[test]
fn old_context_turn_schema_gains_hash_without_rewriting_messages() {
    let c=conn();
    insert(&c,"u","user","original",None,None);
    c.execute_batch("DROP TABLE session_context_turn;
        CREATE TABLE session_context_turn(userMessageId TEXT PRIMARY KEY,sessionId TEXT,transcriptJson TEXT,scopeHash TEXT,createdAt INTEGER);").unwrap();
    migrate(&c).unwrap();migrate(&c).unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_table_info('session_context_turn') WHERE name='sourceHash'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(c.query_row("SELECT content FROM message WHERE id='u'",[],|r|r.get::<_,String>(0)).unwrap(),"original");
    assert!(save_transcript(&c,&scope(),"u",&[ChatMsg::System("forged authority".into())]).is_err());
}


