//! Standalone FEAT-007 type-check harness; not part of application registration.
pub mod models {
    #[derive(serde::Serialize)]
    pub struct FileNode { pub name: String, pub path: String, pub is_dir: bool, pub size: Option<u64> }
    pub fn new_id(prefix: &str) -> String { format!("{}-{}", prefix, uuid::Uuid::new_v4()) }
}
#[path = "fs.rs"]
pub mod fs;
