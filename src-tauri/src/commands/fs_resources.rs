//! Shared admission for FEAT-007 work. Acquire before spawn_blocking or buffers.
use std::sync::atomic::{AtomicUsize, Ordering};
const MAX_TASKS: usize = 8;
const MAX_BYTES: usize = 64 * 1024 * 1024;
static TASKS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static SEARCHES: AtomicUsize = AtomicUsize::new(0);
static BACKGROUND_BYTES: AtomicUsize = AtomicUsize::new(0);
fn take(counter: &'static AtomicUsize, amount: usize, max: usize) -> Result<(), String> {
    counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| used.checked_add(amount).filter(|next| *next <= max))
        .map(|_| ()).map_err(|_| "BUSY_RETRY: 编码区任务或内存预算已满".to_string())
}
pub struct TaskPermit { counter: &'static AtomicUsize }
impl Drop for TaskPermit { fn drop(&mut self) { self.counter.fetch_sub(1, Ordering::AcqRel); } }
pub struct ByteCredit { bytes: usize, background: bool }
impl ByteCredit {
    pub fn acquire(bytes: usize) -> Result<Self, String> { take(&BYTES, bytes, MAX_BYTES)?; Ok(Self { bytes, background: false }) }
    pub fn background(bytes: usize) -> Result<Self, String> {
        take(&BACKGROUND_BYTES, bytes, 48 * 1024 * 1024)?;
        if let Err(error) = take(&BYTES, bytes, MAX_BYTES) { BACKGROUND_BYTES.fetch_sub(bytes, Ordering::AcqRel); return Err(error); }
        Ok(Self { bytes, background: true })
    }
    pub fn shrink(&mut self, bytes: usize) { assert!(bytes <= self.bytes); let released=self.bytes-bytes; BYTES.fetch_sub(released, Ordering::AcqRel); if self.background { BACKGROUND_BYTES.fetch_sub(released, Ordering::AcqRel); } self.bytes=bytes; }
}
impl Drop for ByteCredit { fn drop(&mut self) { BYTES.fetch_sub(self.bytes, Ordering::AcqRel); if self.background { BACKGROUND_BYTES.fetch_sub(self.bytes, Ordering::AcqRel); } } }
pub struct WorkPermit { pub _task: TaskPermit, pub _bytes: ByteCredit }
pub fn admit(bytes: usize) -> Result<WorkPermit, String> {
    take(&TASKS, 1, MAX_TASKS)?;
    let task = TaskPermit { counter: &TASKS };
    let credit = ByteCredit::acquire(bytes)?;
    Ok(WorkPermit { _task: task, _bytes: credit })
}
pub fn search_slot() -> Result<TaskPermit, String> { take(&SEARCHES, 1, 2)?; Ok(TaskPermit { counter: &SEARCHES }) }
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn budget_rejects_before_allocation_and_returns_credit() {
        // An isolated counter tests the exact admission algorithm without global-test races.
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        take(&COUNTER, 64, 64).unwrap(); assert!(take(&COUNTER, 1, 64).is_err());
        assert_eq!(COUNTER.load(Ordering::Acquire), 64);
        COUNTER.fetch_sub(64, Ordering::AcqRel); take(&COUNTER, 1, 64).unwrap();
        COUNTER.fetch_sub(1, Ordering::AcqRel);
    }
}
