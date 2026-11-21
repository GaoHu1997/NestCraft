use super::*;

// ---------------------------------------------------------------------------
// CR-055 / FEAT-007 真实文件系统故障测试。
//
// 约束：所有测试使用 `temp_dir` 下随机目录，走真实 rename/sync；不 mock 文件系统。
// 无法构造 WebviewWindow 的命令入口（begin/append/seal/commit/status）通过其
// 同模块核心（RootedPath/Journal/reconcile/commit_core/duplicate_begin）覆盖，
// 未覆盖到的窗口层在验证报告中单列为“未验证”。
// ---------------------------------------------------------------------------

const OWNER: &str = "cr055-verifier";
const EXTERNAL_PROCESS: &str = "external-verifier-process";

/// 进程级 recovery 目录。RECOVERY 是 OnceLock，整个测试进程只能初始化一次，
/// 因此所有测试共享同一目录，用不同 requestId 隔离。
fn recovery_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("cr055-save-recovery-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let canonical = fs::canonicalize(&dir).unwrap();
        match initialize_recovery(dir) {
            Ok(()) => canonical,
            Err(e) => match RECOVERY.get() {
                Some(path) if path == &canonical => canonical,
                _ => panic!("initialize_recovery 失败: {e}"),
            },
        }
    })
    .clone()
}

fn unique_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cr055-save-{tag}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(&dir).unwrap()
}

struct Fixture {
    id: String,
    root: PathBuf,
    target: PathBuf,
    temp: PathBuf,
    backup: PathBuf,
    root_id: String,
    parent_id: String,
    source_id: String,
    expected_hash: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 清理失败（仍有句柄）不应掩盖测试结论。
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// 在已存在的 root 下构造一个真实的旧 target 文件，并按生产命名规则
/// 推导 temp/backup；source_id/root_id/parent_id 均来自真实句柄。
fn fixture_in(root: &Path, name: &str, old: &[u8]) -> Fixture {
    let id = uuid::Uuid::new_v4().to_string();
    let target = root.join(name);
    fs::write(&target, old).unwrap();
    let root_s = root.to_string_lossy().to_string();
    let target_s = target.to_string_lossy().to_string();
    let pins = guard::RootedPath::new(&root_s, &target_s, false).unwrap();
    let source_id = {
        let file = guard::exclusive(&pins.path, false).unwrap();
        guard::identity(&file).unwrap()
    };
    let temp = pins.path.with_file_name(format!(".nestcraft-editor-{id}.tmp"));
    let backup = pins.path.with_file_name(format!(".nestcraft-editor-{id}.backup"));
    Fixture {
        id,
        root: pins.root.clone(),
        target: pins.path.clone(),
        temp,
        backup,
        root_id: pins.root_id.clone(),
        parent_id: pins.parent_id.clone(),
        source_id,
        expected_hash: digest(old),
    }
}

fn fixture(old: &[u8]) -> Fixture {
    fixture_in(&unique_root("doc"), "文档 名称.txt", old)
}

/// 长路径 + 非 ASCII + 空格的夹具：返回的 base 是 `\\?\` 形式的真实目录。
fn long_path_fixture(old: &[u8]) -> Fixture {
    let base = std::env::temp_dir().join(format!("CR055 保存 验证 {}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();
    let base = fs::canonicalize(&base).unwrap();
    let mut dir = base.clone();
    let mut level = 0u32;
    loop {
        let candidate = dir.join("最终 文档 版本 中文.txt");
        if candidate.as_os_str().len() > 300 {
            break;
        }
        level += 1;
        dir = dir.join(format!("层级 目录 {level} 中文 空格"));
        fs::create_dir_all(&dir).unwrap();
    }
    let target = dir.join("最终 文档 版本 中文.txt");
    assert!(
        target.as_os_str().len() > 260,
        "长路径构造不足 260 字符: {}",
        target.display()
    );
    let relative = target.strip_prefix(&base).unwrap();
    fixture_in(&base, relative.to_str().unwrap(), old)
}

fn record_for(f: &Fixture, phase: &str, temp_id: Option<String>, new: &[u8]) -> Record {
    Record {
        version: 1,
        request_id: f.id.clone(),
        submitted_revision: f.id.clone(),
        owner: OWNER.into(),
        // 与当前进程不同，使 reconcile 跳过 owner 匹配（只校验 root_id）。
        process: EXTERNAL_PROCESS.into(),
        root: f.root.clone(),
        root_id: f.root_id.clone(),
        parent_id: f.parent_id.clone(),
        source_id: f.source_id.clone(),
        temp_id,
        target: f.target.clone(),
        temp: f.temp.clone(),
        backup: f.backup.clone(),
        expected_hash: f.expected_hash.clone(),
        submitted_hash: digest(new),
        encoding: "utf-8".into(),
        total: new.len() as u64,
        written: new.len() as u64,
        next_seq: 1,
        phase: phase.into(),
        error: None,
    }
}

fn write_journal_at(path: &Path, records: &[Record]) -> PathBuf {
    let mut journal = Journal {
        file: OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap(),
        seq: 0,
        previous: String::new(),
    };
    for record in records {
        journal.append(record).unwrap();
    }
    journal.file.sync_all().unwrap();
    drop(journal);
    path.to_path_buf()
}

fn write_journal(f: &Fixture, records: &[Record]) -> PathBuf {
    let _ = recovery_root();
    write_journal_at(&log_path(&f.id).unwrap(), records)
}

/// GC 测试专用扫描目录：放在本次夹具 root 内，走真实目录扫描，但完全避开进程级
/// 共享的 RECOVERY（OnceLock 不可替换；在共享目录里跑“立即回收”会把并发运行的
/// 其他测试的终态证据一起删掉，制造与本功能无关的偶发失败）。
fn private_recovery(root: &Path) -> PathBuf {
    let dir = root.join("recovery");
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn journal_in(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.jsonl"))
}

/// 目录下的普通文件名（排除子目录），排序后返回，便于精确断言"只剩 target"。
fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            meta.file_type()
                .is_file()
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
}

/// 构造一个终态 journal 及其残留材料：backup（复制 target 得到的旧版本内容，
/// 与提交后 backup 的语义一致）与可选 temp（取消 / Destroyed 后未提交的写入内容）。
fn terminal_entry(dir: &Path, f: &Fixture, phase: &str, leftover_temp: bool) -> PathBuf {
    if leftover_temp {
        stage_temp(f, b"new payload");
    }
    fs::copy(&f.target, &f.backup).unwrap();
    write_journal_at(
        &journal_in(dir, &f.id),
        &[record_for(f, phase, None, b"new payload")],
    )
}

fn journal_rows(path: &Path) -> usize {
    String::from_utf8(fs::read(path).unwrap()).unwrap().lines().count()
}

fn last_record(path: &Path, id: &str) -> Record {
    let mut file = File::open(path).unwrap();
    read_journal(&mut file, id).unwrap().0
}

fn reconcile_fixture(f: &Fixture) -> Result<SaveStatus, String> {
    reconcile(OWNER, &f.root_id, &f.id)
}

/// 构造一个内存 Operation（含真实 journal/temp/pins/lock），用于
/// 重复 begin、提交、Destroyed 场景；不经过 WebviewWindow。
fn live_operation(f: &Fixture, phase: &str, new: &[u8], label: &str) -> Arc<Operation> {
    let _ = recovery_root();
    if !f.temp.exists() {
        let mut file = guard::exclusive(&f.temp, true).unwrap();
        file.write_all(new).unwrap();
        file.sync_all().unwrap();
    }
    let temp_id = {
        let file = guard::exclusive(&f.temp, false).unwrap();
        guard::identity(&file).unwrap()
    };
    let record = record_for(f, phase, Some(temp_id), new);
    let mut journal = Journal::create(&f.id).unwrap();
    journal.append(&record).unwrap();
    let root_s = f.root.to_string_lossy().to_string();
    let target_s = f.target.to_string_lossy().to_string();
    let pins = guard::RootedPath::new(&root_s, &target_s, false).unwrap();
    let save = Save {
        record,
        pins,
        file: Some(guard::exclusive(&f.temp, false).unwrap()),
        journal: Some(journal),
        last: None,
        lock: Some(guard::lock_file(&f.source_id).unwrap()),
    };
    let instance = guard::instance(label).unwrap();
    let snapshot = Mutex::new(status(&save.record, false));
    Arc::new(Operation {
        owner: OWNER.into(),
        root_id: f.root_id.clone(),
        instance,
        cancel: AtomicBool::new(false),
        phase: AtomicU8::new(1),
        snapshot,
        state: Mutex::new(save),
    })
}

fn stage_temp(f: &Fixture, bytes: &[u8]) -> String {
    let mut file = guard::exclusive(&f.temp, true).unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    let id = guard::identity(&file).unwrap();
    id
}

// ---------------------------------------------------------------------------
// 1. journal 重放：写入 intent 后丢弃内存状态，重新 initialize_recovery/reconcile。
// ---------------------------------------------------------------------------

#[test]
fn journal_replay_of_intent_reports_explainable_cancelled_not_silent_success() {
    let f = fixture("旧内容 baseline".as_bytes());
    let record = record_for(&f, "intent", None, "新内容 payload".as_bytes());
    let path = write_journal(&f, &[record]);
    let before = fs::read(&path).unwrap();

    // 模拟进程重启：initialize_recovery 是幂等的；reconcile 只依赖磁盘 journal。
    let _ = recovery_root();
    let outcome = reconcile_fixture(&f).expect("intent 重放必须产生可解释结果");

    assert_eq!(outcome.phase, "cancelled", "target 仍是旧文件，恢复应判为 cancelled");
    assert!(!outcome.needs_recovery);
    assert!(outcome.committed_revision.is_none());
    assert_eq!(fs::read(&f.target).unwrap(), "旧内容 baseline".as_bytes(), "恢复不得改写旧 target");
    assert!(!f.temp.exists() && !f.backup.exists(), "intent 阶段没有材料，恢复不得凭空生成");

    let after = fs::read(&path).unwrap();
    assert!(after.len() > before.len(), "恢复结论必须追加写回 journal，不能只在内存成功");
    assert_eq!(journal_rows(&path), 2);
    assert_eq!(last_record(&path, &f.id).phase, "cancelled");
}

#[test]
fn journal_replay_of_intent_without_target_or_backup_requires_recovery() {
    let f = fixture(b"old baseline");
    fs::remove_file(&f.target).unwrap();
    let record = record_for(&f, "intent", None, b"new payload");
    let path = write_journal(&f, &[record]);

    let outcome = reconcile_fixture(&f).expect("必须返回可解释状态，而不是静默成功");

    assert_eq!(outcome.phase, "needs_recovery");
    assert!(outcome.needs_recovery);
    assert!(outcome.committed_revision.is_none());
    assert!(outcome.error.is_some(), "缺少备份时必须给出错误原因");
    assert!(!f.target.exists(), "无材料时不得伪造 target");
    assert_eq!(journal_rows(&path), 2);
}

// ---------------------------------------------------------------------------
// 2. old→backup 之后、temp→target 之前中断。
// ---------------------------------------------------------------------------

#[test]
fn backup_recovery_restores_old_target_without_claiming_commit_or_deleting_temp() {
    let f = fixture(b"old baseline");
    // 崩溃点：old 已经 rename 到 backup，target 暂时缺失，temp 仍在。
    fs::rename(&f.target, &f.backup).unwrap();
    let temp_id = stage_temp(&f, b"new payload");
    let record = record_for(&f, "committing", Some(temp_id), b"new payload");
    let path = write_journal(&f, &[record]);

    let outcome = reconcile_fixture(&f).expect("old→backup 中断应可恢复");

    assert_eq!(outcome.phase, "cancelled", "备份恢复只能回到旧内容，不能伪装成 committed");
    assert!(!outcome.needs_recovery);
    assert!(outcome.committed_revision.is_none());
    assert_eq!(fs::read(&f.target).unwrap(), b"old baseline", "备份必须原样恢复为 target");
    assert!(!f.backup.exists(), "恢复后 backup 已归还 target");
    assert_eq!(fs::read(&f.temp).unwrap(), b"new payload", "恢复路径不得误删未提交的 temp 材料");
    assert_eq!(journal_rows(&path), 2);
    assert_eq!(last_record(&path, &f.id).phase, "cancelled");
}

// ---------------------------------------------------------------------------
// 3. target 已被替换，但尚未完成耐久阶段。
// ---------------------------------------------------------------------------

#[test]
fn replaced_target_with_incomplete_content_is_never_reported_committed() {
    let f = fixture(b"old baseline");
    fs::remove_file(&f.target).unwrap();
    let temp_id = stage_temp(&f, b"new payload");
    fs::rename(&f.temp, &f.target).unwrap();
    // 模拟 rename 后内容不完整/损坏：identity 仍是 temp，但 hash 不匹配。
    fs::write(&f.target, b"new p").unwrap();
    let record = record_for(&f, "replaced", Some(temp_id), b"new payload");
    let path = write_journal(&f, &[record]);

    let outcome = reconcile_fixture(&f).expect("必须返回状态而不是崩溃");

    assert_ne!(outcome.phase, "committed", "内容未通过校验时不得报告成功");
    assert_eq!(outcome.phase, "needs_recovery");
    assert!(outcome.needs_recovery);
    assert!(outcome.committed_revision.is_none());
    assert!(outcome.error.is_some(), "必须说明为什么不能提交");
    assert_eq!(journal_rows(&path), 2);
}

#[test]
fn replaced_target_is_reported_committed_only_after_content_verification() {
    let f = fixture(b"old baseline");
    fs::remove_file(&f.target).unwrap();
    let temp_id = stage_temp(&f, b"new payload");
    fs::rename(&f.temp, &f.target).unwrap();
    let record = record_for(&f, "replaced", Some(temp_id), b"new payload");
    let path = write_journal(&f, &[record.clone()]);

    // 崩溃后直接读记录：phase 仍是 replaced，没有任何提前的成功字段。
    let direct = status(&record, false);
    assert_eq!(direct.phase, "replaced");
    assert!(direct.committed_revision.is_none());
    assert!(direct.source_hash.is_none());
    assert!(direct.source_bytes.is_none());

    let outcome = reconcile_fixture(&f).expect("target 内容完整时应补做耐久并恢复为 committed");
    assert_eq!(outcome.phase, "committed");
    assert_eq!(outcome.committed_revision, Some(f.id.clone()));
    assert_eq!(outcome.source_hash, Some(digest(b"new payload")));
    assert_eq!(fs::read(&f.target).unwrap(), b"new payload");
    assert_eq!(last_record(&path, &f.id).phase, "committed");
}

// ---------------------------------------------------------------------------
// 4. 同 requestId 重复 begin。
// ---------------------------------------------------------------------------

#[test]
fn repeated_begin_returns_existing_state_and_never_rewrites_journal() {
    let f = fixture(b"old baseline");
    let new = b"new payload";
    let op = live_operation(&f, "sealed", new, "cr055-duplicate-begin");
    let id = f.id.clone();
    saves().lock().unwrap().insert(id.clone(), op.clone());
    let path = log_path(&id).unwrap();

    let before = {
        let save = op.state.lock().unwrap();
        save.journal.as_ref().map(|j| (j.seq, j.file.metadata().unwrap().len()))
    };

    let root_s = f.root.to_string_lossy().to_string();
    let target_s = f.target.to_string_lossy().to_string();
    let same = duplicate_begin(
        &op, OWNER, &root_s, &target_s, &f.id, &f.expected_hash,
        digest(new).as_str(), new.len() as u64, "utf-8",
    )
    .expect("相同参数重复 begin 必须返回既有状态");
    assert_eq!(same.phase, "sealed");
    assert_eq!(same.request_id, f.id);
    assert_eq!(same.written_bytes, new.len().to_string());
    assert_eq!(same.next_seq, 1);

    // 幂等：再调用一次仍然是同一状态。
    duplicate_begin(
        &op, OWNER, &root_s, &target_s, &f.id, &f.expected_hash,
        digest(new).as_str(), new.len() as u64, "utf-8",
    )
    .unwrap();

    // 不同 revision / hash / total / encoding：拒绝，且指向 REQUEST_ID_REUSED。
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        duplicate_begin(&op, OWNER, &root_s, &target_s, &other, &f.expected_hash, digest(new).as_str(), new.len() as u64, "utf-8").unwrap_err(),
        "REQUEST_ID_REUSED"
    );
    assert_eq!(
        duplicate_begin(&op, OWNER, &root_s, &target_s, &f.id, &digest(b"other"), digest(new).as_str(), new.len() as u64, "utf-8").unwrap_err(),
        "REQUEST_ID_REUSED"
    );
    assert_eq!(
        duplicate_begin(&op, OWNER, &root_s, &target_s, &f.id, &f.expected_hash, digest(new).as_str(), new.len() as u64 + 1, "utf-8").unwrap_err(),
        "REQUEST_ID_REUSED"
    );
    assert_eq!(
        duplicate_begin(&op, OWNER, &root_s, &target_s, &f.id, &f.expected_hash, digest(new).as_str(), new.len() as u64, "utf-16le").unwrap_err(),
        "REQUEST_ID_REUSED"
    );
    // 不同 owner 与不同 target：拒绝。
    assert_eq!(
        duplicate_begin(&op, "other-owner", &root_s, &target_s, &f.id, &f.expected_hash, digest(new).as_str(), new.len() as u64, "utf-8").unwrap_err(),
        "SAVE_SCOPE"
    );
    let other_target = f.root.join("另一个 目标.txt");
    fs::write(&other_target, b"other").unwrap();
    assert_eq!(
        duplicate_begin(&op, OWNER, &root_s, &other_target.to_string_lossy(), &f.id, &f.expected_hash, digest(new).as_str(), new.len() as u64, "utf-8").unwrap_err(),
        "REQUEST_ID_REUSED"
    );

    let after = {
        let save = op.state.lock().unwrap();
        save.journal.as_ref().map(|j| (j.seq, j.file.metadata().unwrap().len()))
    };
    assert_eq!(before, after, "重复 begin 不得追加或重写已持久 journal");

    saves().lock().unwrap().remove(&id);
    drop(op);
    let _ = fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// 5. 终态只读：committed / failed / cancelled 再次 reconcile，target 被删除也不变。
// ---------------------------------------------------------------------------

#[test]
fn terminal_outcomes_are_read_only_even_after_target_is_deleted() {
    for (phase, error) in [
        ("committed", None),
        ("failed", Some("SAVE_POISONED: 模拟写入失败")),
        ("cancelled", None),
    ] {
        let f = fixture(b"old baseline");
        let mut record = record_for(&f, phase, Some(f.source_id.clone()), b"new payload");
        record.error = error.map(str::to_string);
        let path = write_journal(&f, &[record]);
        let before = fs::read(&path).unwrap();

        // 终态之后 target 被外部删除；reconcile 不得重建、恢复或改写结论。
        fs::remove_file(&f.target).unwrap();
        let outcome = reconcile_fixture(&f).expect("终态必须可重复查询");

        assert_eq!(outcome.phase, phase);
        assert!(!outcome.needs_recovery);
        assert_eq!(fs::read(&path).unwrap(), before, "终态 reconcile 不得追加或改写 journal");
        assert!(!f.target.exists(), "终态 reconcile 不得重建/恢复 target");
        assert!(!f.backup.exists());
    }
}

// ---------------------------------------------------------------------------
// 6. 材料有界 / GC：提交后 temp 不残留、backup 按当前策略保留；回收走独立入口
//    gc_materials / gc_directory（不在成功热路径内）。
// ---------------------------------------------------------------------------

#[test]
fn commit_leaves_no_temp_material_and_retains_backup_by_current_policy() {
    let f = fixture(b"old baseline");
    let new = "new payload 尾".as_bytes();
    let op = live_operation(&f, "sealed", new, "cr055-commit-materials");
    {
        let mut save = op.state.lock().unwrap();
        commit_core(&op, &mut save).expect("sealed 提交应成功");
        save.file.take();
        save.lock.take();
        op.phase.store(3, Ordering::Release);
    }
    drop(op);

    assert_eq!(fs::read(&f.target).unwrap(), new);
    assert!(!f.temp.exists(), "提交完成后不得残留 temp");
    assert!(f.backup.exists(), "当前策略：backup 必须保留");
    assert_eq!(fs::read(&f.backup).unwrap(), b"old baseline");

    let path = log_path(&f.id).unwrap();
    assert_eq!(last_record(&path, &f.id).phase, "committed");

    let mut names: Vec<String> = fs::read_dir(&f.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut expected = vec![
        "文档 名称.txt".to_string(),
        format!(".nestcraft-editor-{}.backup", f.id),
    ];
    expected.sort();
    assert_eq!(names, expected, "目录中只应剩 target 与策略保留的 backup");
    let _ = fs::remove_file(&path);
}

/// a) 提交后调用 GC：backup 与 journal 被回收，target 内容不变。
///
/// 原 `#[ignore]` 版本的断言（提交后立刻 assert 材料消失）与新保留策略冲突：
/// 策略要求"最近 32 条 / 7 天内"的终态材料必须保留，所以提交后材料本该还在，
/// 回收只发生在策略判定期满之后。这里按新策略改写：先证明热路径确实不清理
/// （材料仍在），再用"立即回收"策略（`GcPolicy::reclaim_all_terminal`）证明
/// 回收入口真的删得掉，且不动 target。
#[test]
fn material_gc_reclaims_backup_and_journal_after_commit() {
    let f = fixture(b"old baseline");
    let new = b"new payload";
    let op = live_operation(&f, "sealed", new, "cr055-gc-gap");
    {
        let mut save = op.state.lock().unwrap();
        commit_core(&op, &mut save).expect("sealed 提交应成功");
        save.file.take();
        save.lock.take();
        op.phase.store(3, Ordering::Release);
    }
    drop(op);

    // 提交走的是真实 journal（进程级 RECOVERY 目录）；句柄已随 Operation 释放，
    // 把它原样挪进本测试的私有扫描目录，避免影响并发运行的其他测试。
    let dir = private_recovery(&f.root);
    let moved = journal_in(&dir, &f.id);
    let original = log_path(&f.id).unwrap();
    fs::rename(&original, &moved).unwrap();

    // 前提：成功热路径不清理，材料确实还在——否则下面证明的就不是“回收”。
    assert!(f.backup.exists(), "提交后 backup 必须仍在（清理不在热路径）");
    assert_eq!(fs::read(&f.backup).unwrap(), b"old baseline");
    assert!(!f.temp.exists(), "提交后 temp 已 rename 成 target");
    assert_eq!(last_record(&moved, &f.id).phase, "committed", "journal 必须已落 committed");

    let report = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).expect("回收不得失败");
    assert_eq!(report.scanned, 1);
    assert_eq!(report.retained, 0);
    assert_eq!(report.reclaimed, vec![f.id.clone()]);
    assert_eq!(report.removed_files, 2, "backup 与 journal 各删一个文件");

    assert!(!f.backup.exists(), "终态且超出保留策略的 backup 必须回收");
    assert!(!moved.exists(), "终态且超出保留策略的 journal 必须回收");
    assert_eq!(fs::read(&f.target).unwrap(), new, "回收不得改动 target 内容");
    assert_eq!(
        file_names(&f.root),
        vec!["文档 名称.txt".to_string()],
        "target 同目录只应剩 target 本体（recovery/ 是子目录，不计入）"
    );
}

/// a-补充：取消即终态，但残留的 temp 同样要被回收。
#[test]
fn material_gc_reclaims_leftover_temp_of_cancelled_save() {
    let f = fixture(b"old baseline");
    let dir = private_recovery(&f.root);
    let path = terminal_entry(&dir, &f, "cancelled", true);
    assert!(f.temp.exists() && f.backup.exists());

    let report = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).unwrap();

    assert_eq!(report.reclaimed, vec![f.id.clone()]);
    assert_eq!(report.removed_files, 3, "temp、backup 与 journal 都应回收");
    assert!(!f.temp.exists(), "终态残留的 temp 必须回收");
    assert!(!f.backup.exists(), "终态残留的 backup 必须回收");
    assert!(!path.exists(), "journal 必须回收");
    assert_eq!(fs::read(&f.target).unwrap(), b"old baseline", "回收不得改动 target");
}

/// b) 非终态（intent/staging/sealed/committing/replaced/durability）一个都不回收。
#[test]
fn material_gc_never_reclaims_non_terminal_journals() {
    for phase in [
        "intent",
        "staging",
        "sealed",
        "committing",
        "replaced",
        "durability",
    ] {
        let f = fixture(b"old baseline");
        let dir = private_recovery(&f.root);
        if phase != "intent" {
            stage_temp(&f, b"new payload");
        }
        fs::copy(&f.target, &f.backup).unwrap();
        let path = write_journal_at(
            &journal_in(&dir, &f.id),
            &[record_for(&f, phase, None, b"new payload")],
        );

        // 即便用最激进的策略（保留 0 条 / 0 时长），非终态也不在回收范围。
        let report = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).unwrap();

        assert!(report.reclaimed.is_empty(), "{phase} 是非终态，不得回收任何条目");
        assert_eq!(report.retained, 1);
        assert_eq!(
            report.skipped.first().map(|skip| skip.reason.as_str()),
            Some("NOT_TERMINAL")
        );
        assert!(path.exists(), "{phase}: journal 不得删除");
        assert!(f.backup.exists(), "{phase}: 材料不得删除");
        if phase != "intent" {
            assert!(f.temp.exists(), "{phase}: temp 不得删除");
        }
        assert_eq!(fs::read(&f.target).unwrap(), b"old baseline");
        let _ = fs::remove_file(&path);
    }
}

/// c) needs_recovery 及其材料永不自动回收，重复调用同样不动。
#[test]
fn material_gc_never_reclaims_needs_recovery_journals() {
    let f = fixture(b"old baseline");
    let dir = private_recovery(&f.root);
    stage_temp(&f, b"new payload");
    fs::copy(&f.target, &f.backup).unwrap();
    let mut record = record_for(&f, "needs_recovery", None, b"new payload");
    record.error = Some("TARGET_EXTERNAL_OR_UNKNOWN".into());
    let path = write_journal_at(&journal_in(&dir, &f.id), &[record]);

    let report = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).unwrap();

    assert!(report.reclaimed.is_empty(), "needs_recovery 永不自动回收");
    assert_eq!(
        report.skipped.first().map(|skip| skip.reason.as_str()),
        Some("NEEDS_RECOVERY")
    );
    assert!(path.exists() && f.temp.exists() && f.backup.exists());

    // 幂等：再跑一次结论不变，材料仍在。
    let again = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).unwrap();
    assert!(again.reclaimed.is_empty());
    assert_eq!(again.retained, 1);
    assert!(path.exists() && f.temp.exists() && f.backup.exists());
    assert_eq!(fs::read(&f.target).unwrap(), b"old baseline");
    let _ = fs::remove_file(&path);
}

/// d) 超过保留条数时回收最旧的，保留最新的；target 全部不变。
#[test]
fn material_gc_keeps_newest_entries_and_reclaims_oldest() {
    let root = unique_root("gc-retention");
    let dir = private_recovery(&root);
    let mut entries: Vec<(Fixture, PathBuf)> = Vec::new();
    for index in 0..4 {
        let f = fixture_in(&root, &format!("保留 {index}.txt"), b"old baseline");
        let path = terminal_entry(&dir, &f, "committed", false);
        entries.push((f, path));
        // 终态时间＝journal mtime；真实拉开间隔，让“最旧/最新”不依赖排序巧合。
        std::thread::sleep(Duration::from_millis(20));
    }

    let policy = GcPolicy {
        keep_recent_entries: 2,
        keep_within: Duration::ZERO,
    };
    let report = gc_directory(&dir, policy).unwrap();

    let mut reclaimed = report.reclaimed.clone();
    reclaimed.sort();
    let mut expected = vec![entries[0].0.id.clone(), entries[1].0.id.clone()];
    expected.sort();
    assert_eq!(reclaimed, expected, "只允许回收最旧的两条");
    assert_eq!(report.retained, 2);
    assert_eq!(report.removed_files, 4, "两条旧条目各自 backup + journal");

    for (f, path) in [&entries[0], &entries[1]] {
        assert!(!path.exists(), "最旧条目的 journal 必须回收");
        assert!(!f.backup.exists(), "最旧条目的 backup 必须回收");
        assert_eq!(fs::read(&f.target).unwrap(), b"old baseline", "target 内容不得变化");
    }
    for (f, path) in [&entries[2], &entries[3]] {
        assert!(path.exists(), "最新两条必须在保留条数内");
        assert!(f.backup.exists(), "最新两条的材料必须保留");
        assert_eq!(fs::read(&f.target).unwrap(), b"old baseline");
    }
}

/// e) 幂等：连续调用两次结果一致、无 Err；目录不存在也返回 Ok。
#[test]
fn material_gc_is_idempotent_and_repeatable() {
    let f = fixture(b"old baseline");
    let dir = private_recovery(&f.root);
    let path = terminal_entry(&dir, &f, "committed", true);

    let first = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).expect("首次回收不得失败");
    assert_eq!(first.reclaimed, vec![f.id.clone()]);
    assert_eq!(first.removed_files, 3);

    let second = gc_directory(&dir, GcPolicy::reclaim_all_terminal()).expect("重复调用不得报错");
    assert_eq!(second, GcReport::default(), "重复调用必须是无害的空操作");
    assert!(second.reclaimed.is_empty());
    assert_eq!(second.removed_files, 0);
    assert!(!path.exists(), "文件不得因重复调用而报错或被错误重建");
    assert_eq!(fs::read(&f.target).unwrap(), b"old baseline", "target 本体从未被动过");

    // 目录不存在：不是错误，返回空报告。
    let missing = f.root.join("不存在的 recovery 目录");
    assert_eq!(
        gc_directory(&missing, GcPolicy::default()).expect("目录不存在必须返回 Ok"),
        GcReport::default()
    );
    // 目录为空同样幂等。
    assert_eq!(
        gc_directory(&dir, GcPolicy::default()).unwrap(),
        GcReport::default()
    );
}

/// f) 只回收目标 id 的材料：同目录下其它 id 的材料、以及非本协议的条目全部不动。
#[test]
fn material_gc_only_reclaims_materials_of_the_selected_id() {
    let root = unique_root("gc-isolation");
    let dir = private_recovery(&root);
    let older = fixture_in(&root, "共享目录 旧.txt", b"old baseline");
    let older_path = terminal_entry(&dir, &older, "committed", true);
    std::thread::sleep(Duration::from_millis(20));
    let newer = fixture_in(&root, "共享目录 新.txt", b"old baseline");
    let newer_path = terminal_entry(&dir, &newer, "failed", true);
    // 非本协议条目：名字不是规范 uuid 的 *.jsonl，以及普通文件。
    let foreign = dir.join("别人的 journal.jsonl");
    fs::write(&foreign, b"not a save journal\n").unwrap();

    let policy = GcPolicy {
        keep_recent_entries: 1,
        keep_within: Duration::ZERO,
    };
    let report = gc_directory(&dir, policy).unwrap();

    assert_eq!(report.reclaimed, vec![older.id.clone()], "只允许回收更旧的那个 id");
    assert_eq!(report.scanned, 2, "只认名字可解析为 uuid 的 journal");
    assert!(!older_path.exists() && !older.backup.exists() && !older.temp.exists());

    assert!(newer_path.exists(), "其它 id 的 journal 不得删除");
    assert!(newer.backup.exists(), "同目录下其它 id 的 backup 不得删除");
    assert!(newer.temp.exists(), "同目录下其它 id 的 temp 不得删除");
    assert!(foreign.exists(), "非本协议文件不得删除");

    assert_eq!(fs::read(&older.target).unwrap(), b"old baseline", "target 本体不得删除或改写");
    assert_eq!(fs::read(&newer.target).unwrap(), b"old baseline");
    let _ = fs::remove_file(&foreign);
}

/// 默认策略（保留最近 32 条 / 7 天）下，刚终态的材料必须保留：recency 与条数
/// 取并集，刚提交/取消的材料既不满足"超出条数"也不满足"超出时长"。
#[test]
fn gc_directory_retains_fresh_terminal_material_under_default_policy() {
    let f = fixture(b"old baseline");
    let dir = private_recovery(&f.root);
    let path = terminal_entry(&dir, &f, "committed", true);

    let report = gc_directory(&dir, GcPolicy::default()).expect("默认策略不得报错");

    assert_eq!(report.scanned, 1);
    assert_eq!(report.retained, 1);
    assert!(report.reclaimed.is_empty(), "默认策略：刚终态的材料必须保留");
    assert_eq!(
        report.skipped.first().map(|skip| skip.reason.as_str()),
        Some("RETAINED_BY_POLICY"),
        "必须说明保留原因"
    );
    assert!(path.exists() && f.backup.exists() && f.temp.exists());
    assert_eq!(fs::read(&f.target).unwrap(), b"old baseline");
}

/// 生产入口 `gc_materials` 的目录解析：必须指向 initialize_recovery 初始化的目录。
/// 这里只校验解析（不做真实扫描）——进程级 RECOVERY 是全 crate 测试共享的 OnceLock，
/// 对它做真实扫描会与并发运行的其他测试的独占 reconcile 抢同一批 journal 句柄，
/// 只能在单一进程的真实运行里验证；`gc_directory` 的全部行为已用私有目录覆盖。
#[test]
fn gc_materials_targets_the_initialized_recovery_directory() {
    // recovery_root() 负责（幂等地）初始化进程级 RECOVERY，必须先于 gc_target_dir()。
    let expected = recovery_root();
    let dir = gc_target_dir().expect("测试进程必须已初始化 recovery 目录");
    assert_eq!(dir, expected, "回收必须指向 initialize_recovery 的同一目录");
    assert!(dir.is_dir(), "回收目录必须是真实存在的目录");
}

// ---------------------------------------------------------------------------
// 7. Windows 真实 rename 路径：中文、空格、>260 长路径。
// ---------------------------------------------------------------------------

#[test]
fn windows_commit_and_recovery_handle_unicode_spaces_and_long_paths() {
    // 提交：路径由 begin 阶段的 RootedPath 解析，然后走真实两步 rename。
    let commit_fixture = long_path_fixture("旧 baseline 长路径".as_bytes());
    let root_s = commit_fixture.root.to_string_lossy().to_string();
    let target_s = commit_fixture.target.to_string_lossy().to_string();
    let pins = guard::RootedPath::new(&root_s, &target_s, false).expect("长路径应可解析（begin 路径）");
    assert_eq!(pins.path, commit_fixture.target, r"\\?\ 长路径必须保持稳定");
    assert!(target_s.contains("中文") && target_s.contains(' '), "必须覆盖非 ASCII 与空格");

    let new = "新内容 payload avec espaces".as_bytes();
    let op = live_operation(&commit_fixture, "sealed", new, "cr055-long-path-commit");
    {
        let mut save = op.state.lock().unwrap();
        commit_core(&op, &mut save).expect("长路径提交应成功");
        save.file.take();
        save.lock.take();
        op.phase.store(3, Ordering::Release);
    }
    drop(op);
    assert_eq!(fs::read(&commit_fixture.target).unwrap(), new, "长路径 target 内容必须正确");
    assert_eq!(fs::read(&commit_fixture.backup).unwrap(), "旧 baseline 长路径".as_bytes());
    assert!(!commit_fixture.temp.exists());
    let journal = log_path(&commit_fixture.id).unwrap();
    assert_eq!(last_record(&journal, &commit_fixture.id).phase, "committed");
    let _ = fs::remove_file(&journal);

    // 恢复：同一长路径形态下构造 old→backup 中断，reconcile 必须恢复旧内容。
    let recovery_fixture = long_path_fixture("旧 recovery 长路径".as_bytes());
    fs::rename(&recovery_fixture.target, &recovery_fixture.backup).unwrap();
    let temp_id = stage_temp(&recovery_fixture, b"new recovery");
    let record = record_for(&recovery_fixture, "committing", Some(temp_id), b"new recovery");
    let recovery_journal = write_journal(&recovery_fixture, &[record]);
    let outcome = reconcile_fixture(&recovery_fixture).expect("长路径恢复应成功");
    assert_eq!(outcome.phase, "cancelled");
    assert_eq!(fs::read(&recovery_fixture.target).unwrap(), "旧 recovery 长路径".as_bytes());
    assert_eq!(last_record(&recovery_journal, &recovery_fixture.id).phase, "cancelled");
    let _ = fs::remove_file(&recovery_journal);
}

// ---------------------------------------------------------------------------
// 8. Destroyed / 资源释放。
// ---------------------------------------------------------------------------

#[test]
fn destroyed_cancels_save_and_drops_file_and_lock_handles() {
    let f = fixture(b"old baseline");
    let op = live_operation(&f, "sealed", b"new payload", "cr055-destroy-window");
    let id = f.id.clone();
    saves().lock().unwrap().insert(id.clone(), op.clone());
    let instance = op.instance.clone();

    destroy_instance(&instance);

    assert!(op.cancel.load(Ordering::Acquire), "Destroyed 必须标记取消");
    assert_eq!(op.phase.load(Ordering::Acquire), 3);
    {
        let save = op.state.lock().unwrap();
        assert!(save.file.is_none(), "Destroyed 后必须释放 temp 文件句柄");
        assert!(save.lock.is_none(), "Destroyed 后必须释放实体文件锁");
        assert_eq!(save.record.phase, "cancelled");
    }
    assert!(!guard::file_busy(&f.source_id), "实体文件锁必须已归还");

    let path = log_path(&id).unwrap();
    // Destroyed 后 journal 句柄必须关闭：文件可在无共享写句柄的情况下读取。
    assert!(
        fs::read(&path).is_ok(),
        "Destroyed 后 journal 句柄必须已释放"
    );
    assert!(!saves().lock().unwrap().contains_key(&id), "destroy_instance 必须移除注册表项");

    assert_eq!(last_record(&path, &id).phase, "cancelled", "Destroyed 必须把 cancelled 持久化");
    drop(op);
    let _ = fs::remove_file(&path);
}

#[test]
fn destroyed_releases_save_registry_and_journal_handle() {
    let f = fixture(b"old baseline");
    let op = live_operation(&f, "sealed", b"new payload", "cr055-destroy-gap");
    let id = f.id.clone();
    saves().lock().unwrap().insert(id.clone(), op.clone());
    destroy_instance(&op.instance);

    assert!(!saves().lock().unwrap().contains_key(&id), "Destroyed 后注册表未释放");
    assert!(fs::read(log_path(&id).unwrap()).is_ok(), "Destroyed 后 journal 句柄未释放");
}

// ---------------------------------------------------------------------------
// 既有测试：编码/UUID 校验与 journal hash 链完整性。
// ---------------------------------------------------------------------------

#[test]
fn encoded_bytes_and_uuid_validation() {
    assert_eq!(encode("utf-16le", "😀\r\n").unwrap(), vec![0x3d,0xd8,0,0xde,13,0,10,0]);
    assert_eq!(encode("utf-16be", "😀").unwrap(), vec![0xd8,0x3d,0xde,0]);
    assert!(validate_id("../injected").is_err());
    assert!(encode("utf-8", &"x".repeat(BLOCK + 1)).is_err());
    validate_hash(&digest(b"text")).unwrap();
}
#[test]
fn journal_chain_rejects_truncation_and_mutation() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&dir).unwrap(); let path = dir.join("journal");
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record { version:1, request_id:id.clone(), submitted_revision:id.clone(), owner:"scope".into(), process:"process".into(), root:dir.clone(), root_id:"r".into(), parent_id:"p".into(), source_id:"s".into(), temp_id:Some("t".into()), target:dir.join("target"), temp:dir.join("temp"), backup:dir.join("backup"), expected_hash:digest(b"old"), submitted_hash:digest(b"new"), encoding:"utf-8".into(), total:3, written:3, next_seq:1, phase:"sealed".into(), error:None };
    let mut journal = Journal { file:OpenOptions::new().read(true).write(true).create_new(true).open(&path).unwrap(), seq:0, previous:String::new() };
    journal.append(&record).unwrap(); journal.append(&record).unwrap(); drop(journal);
    let mut file = File::open(&path).unwrap(); assert_eq!(read_journal(&mut file,&id).unwrap().1,2); drop(file);
    let mut bytes = fs::read(&path).unwrap(); bytes.pop(); fs::write(&path,&bytes).unwrap();
    assert!(read_journal(&mut File::open(&path).unwrap(),&id).is_err());
    bytes.push(b'\n'); let position = bytes.windows(6).position(|v|v==b"sealed").unwrap(); bytes[position]=b'x'; fs::write(&path,&bytes).unwrap();
    assert!(read_journal(&mut File::open(&path).unwrap(),&id).is_err());
    fs::remove_dir_all(dir).unwrap();
}