//! FEAT-007 document command bridge.
//! Lease/read was reconstructed from the approved recovery copy in fs_document_read.rs.
//! Save commands are implemented separately and must retain requestId/status semantics.
#[path = "fs_document_read.rs"]
pub mod read;
#[path = "fs_document_save.rs"]
pub mod save;
use super::{guard, resources};
pub use read::{DocumentInfo, WindowData};
// Glob exports also carry Tauri's generated command macros to the registration owner.
pub use read::*;
pub use save::*;
pub fn destroyed(label: &str) {
    if let Some(instance) = guard::destroy(label) {
        read::destroy_instance(&instance);
        save::destroy_instance(&instance);
    }
}
