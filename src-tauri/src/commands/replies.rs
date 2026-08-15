use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::store;

// ---------- Replies ----------

#[tauri::command]
pub fn list_replies(
    state: State<'_, AppState>,
    kind: Option<String>,
) -> Result<Vec<crate::models::Reply>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_replies(&conn, kind.as_deref().filter(|s| !s.is_empty()), 300)
}

#[tauri::command]
pub fn scan_replies(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    crate::inbox::scan_all_accounts(&app, &state.db)
}

