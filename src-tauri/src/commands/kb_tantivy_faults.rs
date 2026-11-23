//! cfg(test) only: deterministic faults delegated through the production observer to real Mmap.
//! No dependency patch, test-only engine, full corpus repetition, or real ACL/disk exhaustion.
use super::*;
use std::cell::RefCell;
use tantivy::directory::{Directory,WritePtr,TerminatingWrite,AntiCallToken,FileHandle,DirectoryLock,Lock,WatchCallback,WatchHandle};
use tantivy::directory::error::{OpenReadError,OpenWriteError,DeleteError,LockError};
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) enum Fault { Enospc,Permission,Write,Flush,Terminate,ReadMissing,AtomicRead,AtomicWrite,Sync,WorkerExit,WorkerTokenPanic,OwnershipOpen,OwnershipPartial,OwnershipFlush }
#[derive(Debug)]
struct State {mode:Fault,fired:AtomicBool}
impl State {
    fn hit(&self,mode:Fault)->bool{self.mode==mode&&!self.fired.swap(true,Ordering::AcqRel)}
    fn error(&self)->std::io::Error {
        #[cfg(windows)] let code=if self.mode==Fault::Permission{5}else{112};
        #[cfg(not(windows))] let code=if self.mode==Fault::Permission{13}else{28};
        std::io::Error::from_raw_os_error(code)
    }
}
thread_local!{static ARMED:RefCell<Option<Arc<State>>>=const{RefCell::new(None)};}
pub(crate) struct Guard {state:Arc<State>}
impl Guard {pub(crate) fn fired(&self)->bool{self.state.fired.load(Ordering::Acquire)}}
impl Drop for Guard {fn drop(&mut self){ARMED.with(|slot|{let mut s=slot.borrow_mut();if s.as_ref().is_some_and(|p|Arc::ptr_eq(p,&self.state)){*s=None;}});}}
pub(crate) fn arm(mode:Fault)->Guard{
    let state=Arc::new(State{mode,fired:AtomicBool::new(false)});
    ARMED.with(|slot|{let mut s=slot.borrow_mut();assert!(s.is_none(),"nested fault guard");*s=Some(state.clone());});Guard{state}
}
pub(super) fn ownership_fault()->Option<Fault>{
    ARMED.with(|slot|slot.borrow().as_ref().and_then(|s|{
        if matches!(s.mode,Fault::OwnershipOpen|Fault::OwnershipPartial|Fault::OwnershipFlush)&&s.hit(s.mode){Some(s.mode)}else{None}
    }))
}
pub(super) fn wrap(inner:Box<dyn Directory>)->Box<dyn Directory>{
    ARMED.with(|slot|match slot.borrow().clone(){Some(state)=>Box::new(FaultDirectory{inner,state}) as Box<dyn Directory>,None=>inner})
}
pub(super) fn tokenizer(inner:tantivy::tokenizer::WhitespaceTokenizer)->tantivy::tokenizer::TextAnalyzer{
    use tantivy::tokenizer::TextAnalyzer;
    ARMED.with(|slot|match slot.borrow().clone(){Some(state)=>TextAnalyzer::from(FaultTokenizer{inner,state}),None=>TextAnalyzer::from(inner)})
}
#[derive(Clone)]
struct FaultTokenizer {inner:tantivy::tokenizer::WhitespaceTokenizer,state:Arc<State>}
impl tantivy::tokenizer::Tokenizer for FaultTokenizer{
    type TokenStream<'a>=FaultTokens<<tantivy::tokenizer::WhitespaceTokenizer as tantivy::tokenizer::Tokenizer>::TokenStream<'a>>;
    fn token_stream<'a>(&'a mut self,text:&'a str)->Self::TokenStream<'a>{FaultTokens{inner:tantivy::tokenizer::Tokenizer::token_stream(&mut self.inner,text),state:self.state.clone()}}
}
struct FaultTokens<T>{inner:T,state:Arc<State>}
impl<T:tantivy::tokenizer::TokenStream> tantivy::tokenizer::TokenStream for FaultTokens<T>{
    fn advance(&mut self)->bool{if self.state.hit(Fault::WorkerTokenPanic){std::panic::panic_any(format!("non_directory_tokenizer_worker_panic {}","中".repeat(4096)));}self.inner.advance()}
    fn token(&self)->&tantivy::tokenizer::Token{self.inner.token()}
    fn token_mut(&mut self)->&mut tantivy::tokenizer::Token{self.inner.token_mut()}
}
#[derive(Clone,Debug)]
struct FaultDirectory {inner:Box<dyn Directory>,state:Arc<State>}
impl Directory for FaultDirectory {
    fn get_file_handle(&self,path:&Path)->Result<Arc<dyn FileHandle>,OpenReadError>{
        if path.extension().is_some_and(|s|s=="store")&&self.state.hit(Fault::ReadMissing){return Err(OpenReadError::FileDoesNotExist(path.into()));}
        self.inner.get_file_handle(path)
    }
    fn delete(&self,path:&Path)->Result<(),DeleteError>{self.inner.delete(path)}
    fn exists(&self,path:&Path)->Result<bool,OpenReadError>{self.inner.exists(path)}
    fn open_write(&self,path:&Path)->Result<WritePtr,OpenWriteError>{
        let segment=path.extension().is_some_and(|s|s=="fieldnorm");
        if segment&&(self.state.hit(Fault::Enospc)||self.state.hit(Fault::Permission)){return Err(OpenWriteError::wrap_io_error(self.state.error(),path.into()));}
        if segment&&self.state.hit(Fault::WorkerExit){panic!("deterministic Tantivy indexing worker exit");}
        let writer=self.inner.open_write(path)?;
        if !segment{return Ok(writer);}
        let capacity=writer.capacity();let inner=writer.into_inner().map_err(|e|OpenWriteError::wrap_io_error(e.into_error(),path.into()))?;
        Ok(std::io::BufWriter::with_capacity(capacity,Box::new(FaultWrite{inner,state:self.state.clone()})))
    }
    fn atomic_read(&self,path:&Path)->Result<Vec<u8>,OpenReadError>{
        if path==Path::new("meta.json")&&self.state.hit(Fault::AtomicRead){return Err(OpenReadError::wrap_io_error(self.state.error(),path.into()));}self.inner.atomic_read(path)
    }
    fn atomic_write(&self,path:&Path,data:&[u8])->std::io::Result<()>{
        if path==Path::new(".managed.json")&&self.state.hit(Fault::AtomicWrite){return Err(self.state.error());}self.inner.atomic_write(path,data)
    }
    fn sync_directory(&self)->std::io::Result<()>{if self.state.hit(Fault::Sync){return Err(self.state.error());}self.inner.sync_directory()}
    fn acquire_lock(&self,lock:&Lock)->Result<DirectoryLock,LockError>{self.inner.acquire_lock(lock)}
    fn watch(&self,callback:WatchCallback)->tantivy::Result<WatchHandle>{self.inner.watch(callback)}
}
struct FaultWrite {inner:Box<dyn TerminatingWrite+Send+Sync>,state:Arc<State>}
impl std::io::Write for FaultWrite {
    fn write(&mut self,data:&[u8])->std::io::Result<usize>{if self.state.hit(Fault::Write){return Err(self.state.error());}self.inner.write(data)}
    fn flush(&mut self)->std::io::Result<()>{if self.state.hit(Fault::Flush){return Err(self.state.error());}self.inner.flush()}
}
impl TerminatingWrite for FaultWrite {
    fn terminate_ref(&mut self,token:AntiCallToken)->std::io::Result<()>{if self.state.hit(Fault::Terminate){return Err(self.state.error());}self.inner.terminate_ref(token)}
}
