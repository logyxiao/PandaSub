//! Tauri 命令层：按领域拆分到子模块，统一在此转发。
//!
//! 拆分后 lib.rs 的 `generate_handler!` 仍引用 `commands::xxx` 路径，无需改动。

pub mod accounts;
pub mod dashboard;
pub mod editors;
pub mod logs;
pub mod manuscripts;
pub mod replies;
pub mod system;
pub mod tasks;

pub use accounts::*;
pub use dashboard::*;
pub use editors::*;
pub use logs::*;
pub use manuscripts::*;
pub use replies::*;
pub use system::*;
pub use tasks::*;
